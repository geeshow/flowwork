"""워크플로우용 API 인덱스(catalog.py) — API 콜렉션 평탄화 테스트."""
import tempfile

import pytest
from fastapi.testclient import TestClient

from app import bruno
from app.catalog import apic_request_to_template, extract_template_variables


@pytest.fixture()
def client(monkeypatch):
    # 콜렉션 쓰기는 source=edit(develop worktree)만 허용 — edit(develop) 경로를
    # prod(DATA_DIR)와 같은 디렉토리로 배치해 기본 파라미터로 읽기/쓰기를 검증한다.
    from pathlib import Path

    tmp_parent = Path(tempfile.mkdtemp())
    tmp = tmp_parent / "develop"
    tmp.mkdir()
    monkeypatch.setenv("FLOWWORK_DATA_DIR", str(tmp))
    monkeypatch.setenv("FLOWWORK_EDIT_DATA_DIR", str(tmp_parent))
    import importlib

    import app.catalog as catalog
    import app.collections as collections
    import app.config as config
    import app.storage as storage
    import main

    importlib.reload(config)
    importlib.reload(storage)
    importlib.reload(collections)
    importlib.reload(catalog)
    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c


def _seed_collection(client) -> dict:
    client.post("/api/apic/workspaces", json={"name": "core"})
    doc = client.post("/api/apic/workspaces/core/collections", json={"name": "코어 API"}).json()
    doc["items"] = [
        {
            "type": "folder",
            "name": "계좌",
            "items": [
                {
                    "type": "http",
                    "name": "계좌 출금",
                    "request": {
                        "method": "POST",
                        "url": "{{coreBaseUrl}}/accounts/{{accountNo}}/withdraw",
                        "headers": [
                            {"name": "Authorization", "value": "Bearer {{authToken}}", "enabled": True},
                            {"name": "X-Debug", "value": "1", "enabled": False},
                        ],
                        "params": [],
                        "body": {"mode": "json", "json": '{"amount": {{amount}}}'},
                        "output": [{"name": "accountNo", "label": "계좌번호"}, "balanceAfter"],
                    },
                }
            ],
        },
        {
            "type": "http",
            "name": "계좌 목록",
            "request": {
                "method": "GET",
                "url": "{{coreBaseUrl}}/accounts",
                "headers": [],
                "params": [{"name": "status", "value": "ACTIVE", "enabled": True, "kind": "query"}],
                "body": {"mode": "none"},
            },
        },
    ]
    doc["environments"] = [
        {"name": "local", "variables": [{"name": "coreBaseUrl", "value": "http://localhost:9100", "enabled": True}]}
    ]
    doc["activeEnvironment"] = "local"
    client.put(f"/api/apic/workspaces/core/collections/{doc['id']}", json=doc)
    return doc


def test_extract_template_variables_dedup_and_order():
    template = {
        "url": {"raw": "{{baseUrl}}/api/customers/{{customerId}}/settle"},
        "body": {"raw": "{\"amount\": {{amount}}, \"who\": \"{{customerId}}\"}"},
    }
    assert extract_template_variables(template) == ["baseUrl", "customerId", "amount"]


def test_apic_request_to_template_query_and_headers():
    template = apic_request_to_template(
        {
            "method": "GET",
            "url": "{{base}}/list",
            "headers": [
                {"name": "A", "value": "1", "enabled": True},
                {"name": "B", "value": "2", "enabled": False},  # 비활성 제외
            ],
            "params": [
                {"name": "q", "value": "{{kw}}", "enabled": True, "kind": "query"},
                {"name": "skip", "value": "x", "enabled": False, "kind": "query"},  # 비활성 제외
                {"name": "id", "value": "y", "enabled": True, "kind": "path"},  # path는 url 병합 안 함
            ],
            "body": {"mode": "json", "json": '{"a": 1}'},
        }
    )
    assert template["url"]["raw"] == "{{base}}/list?q={{kw}}"
    assert template["header"] == [{"key": "A", "value": "1"}]
    assert template["body"] == {"mode": "raw", "raw": '{"a": 1}'}


def test_search_flattens_collections(client):
    doc = _seed_collection(client)
    res = client.get("/api/catalog/search").json()
    by_name = {e["name"]: e for e in res["results"]}
    assert set(by_name) == {"계좌 출금", "계좌 목록"}

    withdraw = by_name["계좌 출금"]
    assert withdraw["department"] == "core"  # workspace 이름
    assert withdraw["collectionFile"] == doc["id"]  # 콜렉션 id 참조
    assert withdraw["collectionName"] == "코어 API"  # 편집기 필터 표시용
    assert withdraw["itemPath"] == ["계좌"]
    # 순서는 템플릿 직렬화 순서(헤더→URL→바디)를 따른다
    assert withdraw["variables"] == ["authToken", "coreBaseUrl", "accountNo", "amount"]
    assert withdraw["outputFields"] == ["accountNo", "balanceAfter"]
    assert withdraw["outputLabels"] == {"accountNo": "계좌번호"}  # 한글 설명(라벨)
    # 비활성 헤더는 템플릿에서 제외
    assert [h["key"] for h in withdraw["requestTemplate"]["header"]] == ["Authorization"]

    # 쿼리 파라미터는 url에 병합
    assert by_name["계좌 목록"]["url"] == "{{coreBaseUrl}}/accounts?status=ACTIVE"

    # 검색 필터
    res = client.get("/api/catalog/search", params={"q": "출금"}).json()
    assert [e["name"] for e in res["results"]] == ["계좌 출금"]


def test_entry_ids_unique_and_lookup(client):
    _seed_collection(client)
    res = client.get("/api/catalog/search").json()["results"]
    ids = [e["id"] for e in res]
    assert len(ids) == len(set(ids))
    entry = client.get(f"/api/catalog/entry/{ids[0]}").json()
    assert entry["id"] == ids[0]


def test_environments_merged_from_collections(client):
    _seed_collection(client)
    values = client.get("/api/catalog/environments").json()["values"]
    assert values == {"coreBaseUrl": "http://localhost:9100"}


def test_collection_edit_reflected_immediately(client):
    """콜렉션 편집이 재기동 없이 인덱스에 반영된다 (실시간 스캔)."""
    doc = _seed_collection(client)
    doc["items"][1]["name"] = "계좌 전체 목록"
    client.put(f"/api/apic/workspaces/core/collections/{doc['id']}", json=doc)
    names = {e["name"] for e in client.get("/api/catalog/search").json()["results"]}
    assert "계좌 전체 목록" in names and "계좌 목록" not in names


def test_bruno_request_parse():
    text = """
meta {
  name: 계좌 출금
  type: http
  seq: 4
}

post {
  url: {{coreBaseUrl}}/accounts/{{accountNo}}/withdraw
  body: json
  auth: none
}

headers {
  Authorization: Bearer {{authToken}}
  Content-Type: application/json
}

body:json {
  {"amount": {{amount}}, "password": "{{password}}"}
}

docs {
  output: accountNo, status, balanceAfter
}
"""
    parsed = bruno.parse_request(text)
    assert parsed["name"] == "계좌 출금"
    req = parsed["request"]
    assert req["method"] == "POST"
    assert req["url"]["raw"] == "{{coreBaseUrl}}/accounts/{{accountNo}}/withdraw"
    assert req["header"][0] == {"key": "Authorization", "value": "Bearer {{authToken}}"}
    assert req["body"]["raw"] == '{"amount": {{amount}}, "password": "{{password}}"}'
    assert parsed["bodyMode"] == "json"
    assert parsed["output"] == ["accountNo", "status", "balanceAfter"]


def test_bruno_environment_parse():
    text = "vars {\n  coreBaseUrl: http://localhost:9100/core\n}\n"
    assert bruno.parse_environment(text) == {"coreBaseUrl": "http://localhost:9100/core"}
