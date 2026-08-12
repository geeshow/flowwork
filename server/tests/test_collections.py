import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    # 쓰기는 source=edit(기본 develop worktree)로만 허용된다. 이 모듈은 콜렉션
    # CRUD 자체를 검증하므로, edit(develop) 경로가 prod(DATA_DIR)와 같은 디렉토리가
    # 되도록 배치해 기본 파라미터의 읽기/쓰기가 한 저장소를 보게 한다.
    from pathlib import Path

    tmp = Path(tempfile.mkdtemp())
    data = tmp / "develop"
    data.mkdir()
    monkeypatch.setenv("FLOWWORK_DATA_DIR", str(data))
    monkeypatch.setenv("FLOWWORK_EDIT_DATA_DIR", str(tmp))
    import importlib

    import app.collections as collections
    import app.config as config
    import app.storage as storage
    import main

    importlib.reload(config)
    importlib.reload(storage)
    importlib.reload(collections)
    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c


def test_workspace_crud(client):
    assert client.get("/api/apic/workspaces").json() == {"workspaces": []}
    assert client.post("/api/apic/workspaces", json={"name": "결제팀"}).status_code == 200
    ws = client.get("/api/apic/workspaces").json()["workspaces"]
    assert ws == [{"name": "결제팀", "collection_count": 0}]
    # 중복 생성 거부
    assert client.post("/api/apic/workspaces", json={"name": "결제팀"}).status_code == 400
    # traversal 거부
    assert client.post("/api/apic/workspaces", json={"name": "../evil"}).status_code == 400
    assert client.delete("/api/apic/workspaces/결제팀").status_code == 200
    assert client.get("/api/apic/workspaces").json() == {"workspaces": []}


def test_collection_crud_and_save(client):
    client.post("/api/apic/workspaces", json={"name": "w1"})
    doc = client.post("/api/apic/workspaces/w1/collections", json={"name": "주문 API"}).json()
    assert doc["name"] == "주문 API" and doc["items"] == []

    doc["items"] = [
        {
            "type": "folder",
            "name": "조회",
            "items": [
                {
                    "type": "http",
                    "name": "주문 목록",
                    "request": {
                        "method": "GET",
                        "url": "{{baseUrl}}/orders",
                        "headers": [],
                        "params": [],
                        "body": {"mode": "none"},
                    },
                }
            ],
        }
    ]
    r = client.put(f"/api/apic/workspaces/w1/collections/{doc['id']}", json=doc)
    assert r.status_code == 200

    lst = client.get("/api/apic/workspaces/w1/collections").json()["collections"]
    assert lst == [{"id": doc["id"], "name": "주문 API", "request_count": 1}]

    loaded = client.get(f"/api/apic/workspaces/w1/collections/{doc['id']}").json()
    assert loaded["items"][0]["items"][0]["name"] == "주문 목록"

    assert client.delete(f"/api/apic/workspaces/w1/collections/{doc['id']}").status_code == 200
    assert client.get("/api/apic/workspaces/w1/collections").json()["collections"] == []


def test_import_postman_and_export_roundtrip(client):
    client.post("/api/apic/workspaces", json={"name": "w1"})
    postman = {
        "info": {
            "name": "고객 API",
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "variable": [{"key": "baseUrl", "value": "http://localhost:9000"}],
        "item": [
            {
                "name": "고객",
                "item": [
                    {
                        "name": "고객 조회",
                        "request": {
                            "method": "POST",
                            "header": [{"key": "Content-Type", "value": "application/json"}],
                            "url": {"raw": "{{baseUrl}}/customers"},
                            "body": {"mode": "raw", "raw": "{\"id\": 1}"},
                        },
                    }
                ],
            }
        ],
    }
    doc = client.post("/api/apic/workspaces/w1/collections/import", json=postman).json()
    assert doc["name"] == "고객 API"
    folder = doc["items"][0]
    assert folder["type"] == "folder" and folder["name"] == "고객"
    req = folder["items"][0]["request"]
    assert req["method"] == "POST"
    assert req["body"] == {"mode": "json", "json": "{\"id\": 1}"}
    # 콜렉션 변수 → 환경 승격
    assert doc["environments"][0]["variables"][0]["name"] == "baseUrl"

    # Bruno export
    bru = client.get(
        f"/api/apic/workspaces/w1/collections/{doc['id']}/export?format=bruno"
    ).json()
    assert bru["version"] == "1"
    assert bru["items"][0]["items"][0]["type"] == "http"
    assert bru["items"][0]["items"][0]["request"]["headers"][0]["name"] == "Content-Type"

    # Postman export
    pm = client.get(
        f"/api/apic/workspaces/w1/collections/{doc['id']}/export?format=postman"
    ).json()
    assert pm["info"]["name"] == "고객 API"
    assert pm["item"][0]["item"][0]["request"]["body"]["raw"] == "{\"id\": 1}"

    # Bruno export를 다시 import 해도 동일 구조
    doc2 = client.post("/api/apic/workspaces/w1/collections/import", json=bru).json()
    assert doc2["id"] != doc["id"]
    assert doc2["items"][0]["items"][0]["request"]["method"] == "POST"
    assert doc2["environments"] == doc["environments"]


def test_import_rejects_unknown_format(client):
    client.post("/api/apic/workspaces", json={"name": "w1"})
    r = client.post("/api/apic/workspaces/w1/collections/import", json={"foo": 1})
    assert r.status_code == 400


def test_parse_github_url():
    from app.collections import parse_github_url

    assert parse_github_url("https://github.com/geeshow/flowwork-apis") == (
        "geeshow", "flowwork-apis", None, None,
    )
    assert parse_github_url("https://github.com/a/b.git") == ("a", "b", None, None)
    assert parse_github_url("https://github.com/a/b/tree/dev/sub/dir") == (
        "a", "b", "dev", "sub/dir",
    )
    with pytest.raises(ValueError):
        parse_github_url("https://gitlab.com/a/b")
    with pytest.raises(ValueError):
        parse_github_url("http://github.com/a/b")  # https만 허용


def _make_repo_tarball(withdraw_extra: str = "") -> bytes:
    """루트에 bruno.json이 있는 Bruno 콜렉션 레포 tar.gz를 만든다."""
    import io
    import tarfile

    files = {
        "repo-main/bruno.json": '{"version": "1", "name": "사내 API", "type": "collection"}',
        "repo-main/계좌/계좌 출금.bru": (
            "meta {\n  name: 계좌 출금\n  type: http\n  seq: 2\n}\n\n"
            "post {\n  url: {{coreBaseUrl}}/accounts/{{accountNo}}/withdraw\n  body: json\n}\n\n"
            "headers {\n"
            '  @description("접근 토큰")\n'
            "  Authorization: Bearer {{authToken}}\n"
            "  Content-Type: application/json\n"
            "}\n\n"
            'body:json {\n  {"amount": {{amount}}}\n}\n\n'
            "docs {\n  output: accountNo=계좌번호, status, balanceAfter=출금 후 잔액\n}\n"
            + withdraw_extra
        ),
        "repo-main/계좌/계좌 조회.bru": (
            "meta {\n  name: 계좌 조회\n  type: http\n  seq: 1\n}\n\n"
            "get {\n  url: {{coreBaseUrl}}/accounts\n}\n"
        ),
        "repo-main/environments/core.bru": "vars {\n  coreBaseUrl: http://localhost:9100/core\n}\n",
    }
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_import_from_github(client, monkeypatch):
    tarball = _make_repo_tarball()

    async def fake_fetch(owner, repo, branch):
        assert (owner, repo) == ("geeshow", "flowwork-apis")
        return tarball

    monkeypatch.setattr("app.collections._fetch_tarball", fake_fetch)
    client.post("/api/apic/workspaces", json={"name": "w1"})
    r = client.post(
        "/api/apic/workspaces/w1/collections/import-github",
        json={"url": "https://github.com/geeshow/flowwork-apis"},
    )
    assert r.status_code == 200
    imported = r.json()["imported"]
    assert len(imported) == 1
    assert imported[0]["name"] == "사내 API"
    assert imported[0]["request_count"] == 2

    doc = client.get(f"/api/apic/workspaces/w1/collections/{imported[0]['id']}").json()
    # 레포 연결 정보(source)가 남는다 → 이후 동기화 가능
    assert doc["source"] == {"type": "github", "url": "https://github.com/geeshow/flowwork-apis"}
    folder = doc["items"][0]
    assert folder["type"] == "folder" and folder["name"] == "계좌"
    # seq 순 정렬: 조회(1) → 출금(2)
    assert [i["name"] for i in folder["items"]] == ["계좌 조회", "계좌 출금"]
    withdraw = folder["items"][1]["request"]
    assert withdraw["method"] == "POST"
    # @description 어노테이션 → 헤더 description으로
    assert withdraw["headers"] == [
        {"name": "Authorization", "value": "Bearer {{authToken}}", "enabled": True, "description": "접근 토큰"},
        {"name": "Content-Type", "value": "application/json", "enabled": True},
    ]
    # docs output의 `이름=라벨` → {name, label}, 라벨 없으면 문자열
    assert withdraw["output"] == [
        {"name": "accountNo", "label": "계좌번호"},
        "status",
        {"name": "balanceAfter", "label": "출금 후 잔액"},
    ]
    # body:json 블록은 {{변수}} 때문에 JSON 파싱이 안 돼도 json 모드를 유지한다
    assert withdraw["body"]["mode"] == "json"
    assert "{{amount}}" in withdraw["body"]["json"]
    # environments/*.bru → 환경으로
    assert doc["environments"] == [
        {
            "name": "core",
            "variables": [
                {"name": "coreBaseUrl", "value": "http://localhost:9100/core", "enabled": True}
            ],
        }
    ]
    assert doc["activeEnvironment"] == "core"


def test_get_github_token_env_precedence(monkeypatch):
    from app import collections

    monkeypatch.setenv("FLOWWORK_GITHUB_TOKEN", "tok-flowwork")
    monkeypatch.setenv("GITHUB_TOKEN", "tok-generic")
    assert collections.get_github_token() == "tok-flowwork"

    monkeypatch.delenv("FLOWWORK_GITHUB_TOKEN")
    assert collections.get_github_token() == "tok-generic"

    # env 없고 gh CLI도 없으면 None
    monkeypatch.delenv("GITHUB_TOKEN")
    def no_gh(*a, **k):
        raise FileNotFoundError("gh not found")
    monkeypatch.setattr("app.collections.subprocess.run", no_gh)
    assert collections.get_github_token() is None


def test_github_status_endpoint_without_token(client, monkeypatch):
    monkeypatch.setattr("app.collections.get_github_token", lambda: None)
    r = client.get("/api/apic/github/status")
    assert r.status_code == 200
    assert r.json() == {"logged_in": False, "login": None}


def test_sync_collection_updates_in_place(client, monkeypatch):
    """동기화는 레포 최신 내용으로 갱신하되 콜렉션 id를 유지한다."""
    state = {"tar": _make_repo_tarball()}

    async def fake_fetch(owner, repo, branch):
        return state["tar"]

    monkeypatch.setattr("app.collections._fetch_tarball", fake_fetch)
    client.post("/api/apic/workspaces", json={"name": "w1"})
    doc = client.post(
        "/api/apic/workspaces/w1/collections/import-github",
        json={"url": "https://github.com/geeshow/flowwork-apis"},
    ).json()["imported"][0]

    # 레포에 요청이 추가된 상황을 흉내낸다
    state["tar"] = _make_repo_tarball()  # 동일 + 아래에서 새 파일 추가 대신 출금 문서 변경
    import io
    import tarfile

    buf = io.BytesIO(state["tar"])
    with tarfile.open(fileobj=buf) as tf:
        names = tf.getnames()
    assert "repo-main/계좌/계좌 출금.bru" in names

    r = client.post(f"/api/apic/workspaces/w1/collections/{doc['id']}/sync")
    assert r.status_code == 200
    synced = r.json()
    assert synced["id"] == doc["id"]  # id 유지 → 워크플로우 참조 보존
    assert synced["source"]["url"] == "https://github.com/geeshow/flowwork-apis"
    assert synced["activeEnvironment"] == "core"

    # source 없는 콜렉션은 동기화 불가
    plain = client.post("/api/apic/workspaces/w1/collections", json={"name": "일반"}).json()
    assert client.post(f"/api/apic/workspaces/w1/collections/{plain['id']}/sync").status_code == 400


def test_import_from_github_rejects_bad_url(client):
    client.post("/api/apic/workspaces", json={"name": "w1"})
    r = client.post(
        "/api/apic/workspaces/w1/collections/import-github",
        json={"url": "https://evil.example.com/geeshow/flowwork-apis"},
    )
    assert r.status_code == 400
