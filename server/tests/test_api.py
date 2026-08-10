import os
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("FLOWWORK_DATA_DIR", tmp)
    # config는 import 시점에 경로를 고정하므로, 모듈을 새로 로드해야 tmp가 반영된다.
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


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_proxy_rejects_non_allowlisted_host(client):
    resp = client.post(
        "/api/proxy",
        json={
            "execution_id": "e1",
            "step_id": "s1",
            "method": "GET",
            "url": "http://evil.example.com/x",
        },
    )
    assert resp.status_code == 403


def _wf(wf_id, domain, task, name):
    return {
        "id": wf_id,
        "domain": domain,
        "task": task,
        "name": name,
        "baseInputs": [{"kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string"}],
        "steps": [{"id": "step_1", "order": 1, "name": "조회"}],
    }


def test_workflow_crud_roundtrip(client):
    wf = _wf("wf_demo", "계좌", "사용자관리", "데모")
    assert client.put("/api/workflows/wf_demo", json=wf).json() == {"status": "saved"}

    got = client.get("/api/workflows/wf_demo").json()
    assert got["name"] == "데모"
    assert got["domain"] == "계좌" and got["task"] == "사용자관리"

    listing = client.get("/api/workflows").json()["workflows"]
    assert any(w["id"] == "wf_demo" for w in listing)

    assert client.delete("/api/workflows/wf_demo").json() == {"status": "deleted"}
    assert client.get("/api/workflows/wf_demo").status_code == 404


def test_workflow_name_unique_within_domain_task(client):
    client.put("/api/workflows/id_a", json=_wf("id_a", "계좌", "개설", "계좌 개설"))
    # 같은 도메인/업무에 같은 이름 → 409
    dup = client.put("/api/workflows/id_b", json=_wf("id_b", "계좌", "개설", "계좌 개설"))
    assert dup.status_code == 409
    # 다른 업무면 같은 이름 허용
    ok = client.put("/api/workflows/id_c", json=_wf("id_c", "계좌", "폐쇄", "계좌 개설"))
    assert ok.status_code == 200


def test_workflow_moves_file_on_domain_change(client):
    client.put("/api/workflows/mv1", json=_wf("mv1", "계좌", "개설", "이동테스트"))
    # 도메인/업무를 바꿔 저장 → id는 그대로, 경로 이동
    client.put("/api/workflows/mv1", json=_wf("mv1", "매매", "주문", "이동테스트"))
    got = client.get("/api/workflows/mv1").json()
    assert got["domain"] == "매매" and got["task"] == "주문"
    # 목록에 중복 없이 한 건만
    listing = client.get("/api/workflows").json()["workflows"]
    assert len([w for w in listing if w["id"] == "mv1"]) == 1


def test_workflow_rejects_unsafe_segment(client):
    wf = _wf("x", "..", "t", "x")
    resp = client.put("/api/workflows/x", json=wf)
    assert resp.status_code == 400


def test_domain_color_roundtrip(client):
    # 기본은 빈 매핑
    assert client.get("/api/domains").json() == {"colors": {}}
    # 유효한 hex 저장 후 조회
    assert client.put("/api/domains/계좌", json={"color": "#f2b544"}).json() == {"status": "saved"}
    assert client.get("/api/domains").json()["colors"] == {"계좌": "#f2b544"}
    # 덮어쓰기
    client.put("/api/domains/계좌", json={"color": "#4c8dff"})
    assert client.get("/api/domains").json()["colors"]["계좌"] == "#4c8dff"


def test_domain_color_rejects_non_hex(client):
    assert client.put("/api/domains/계좌", json={"color": "blue"}).status_code == 400
    assert client.put("/api/domains/계좌", json={"color": "#12"}).status_code == 400
    # 잘못된 값 저장 실패 후에도 매핑은 비어 있어야 한다
    assert client.get("/api/domains").json() == {"colors": {}}


def test_catalog_search_indexes_api_collections(client):
    """워크플로우용 API 인덱스는 API 콜렉션에 등록된 요청만 노출한다."""
    assert client.get("/api/catalog/search").json()["results"] == []  # 콜렉션 없음 → 빈 인덱스

    client.post("/api/apic/workspaces", json={"name": "payments"})
    doc = client.post("/api/apic/workspaces/payments/collections", json={"name": "정산"}).json()
    doc["items"] = [
        {
            "type": "http",
            "name": "정산 조회",
            "request": {
                "method": "GET",
                "url": "{{baseUrl}}/settlements",
                "headers": [],
                "params": [],
                "body": {"mode": "none"},
            },
        }
    ]
    client.put(f"/api/apic/workspaces/payments/collections/{doc['id']}", json=doc)

    resp = client.get("/api/catalog/search", params={"q": "정산"}).json()
    names = [e["name"] for e in resp["results"]]
    assert "정산 조회" in names


def test_execution_not_found(client):
    assert client.get("/api/executions/nope").status_code == 404


def test_proxy_without_execution_id_does_not_log(client, monkeypatch):
    class FakeResp:
        status_code = 200
        text = ""

        def json(self):
            return {"data": [{"id": "C1"}]}

    async def fake_request(self, method, url, **kw):
        return FakeResp()

    monkeypatch.setattr("httpx.AsyncClient.request", fake_request)

    before = len(client.get("/api/executions").json()["executions"])
    r = client.post(
        "/api/proxy",
        json={"method": "GET", "url": "http://localhost:9100/api/customers"},
    )
    assert r.status_code == 200
    assert r.json()["response"]["body"] == {"data": [{"id": "C1"}]}
    after = len(client.get("/api/executions").json()["executions"])
    assert after == before  # 이력에 남지 않음


def test_proxy_returns_full_body_but_stores_redacted(client, monkeypatch):
    class FakeResp:
        status_code = 200
        text = ""

        def json(self):
            return {"accessToken": "SECRET123", "data": {"id": "X"}}

    async def fake_request(self, method, url, **kw):
        return FakeResp()

    monkeypatch.setattr("httpx.AsyncClient.request", fake_request)

    r = client.post(
        "/api/proxy",
        json={
            "execution_id": "e-red",
            "step_id": "s1",
            "method": "GET",
            "url": "http://localhost:9100/x",
        },
    )
    # 프론트로는 전체 응답 반환 (체이닝을 위해 토큰이 보여야 함)
    assert r.json()["response"]["body"]["accessToken"] == "SECRET123"

    # 이력에는 리댁션된 사본 저장 (URL 공유 유출 방지)
    detail = client.get("/api/executions/e-red").json()
    assert detail["steps"][0]["response"]["body"]["accessToken"] == "***REDACTED***"
    assert detail["steps"][0]["response"]["body"]["data"]["id"] == "X"


def test_execution_inputs_recorded_redacted_and_excluded_from_counts(client, monkeypatch):
    class FakeResp:
        status_code = 200
        text = ""

        def json(self):
            return {"data": {"ok": True}}

    async def fake_request(self, method, url, **kw):
        return FakeResp()

    monkeypatch.setattr("httpx.AsyncClient.request", fake_request)

    # 스텝 1건 실행
    client.post(
        "/api/proxy",
        json={
            "execution_id": "e-in",
            "step_id": "s1",
            "workflow_id": "wf1",
            "method": "GET",
            "url": "http://localhost:9100/x",
        },
    )
    # 입력값 기록 (비밀번호 포함 → 리댁션)
    r = client.post(
        "/api/executions/e-in/inputs",
        json={"values": {"app_user_id": "U1", "password": "0000"}, "workflow_id": "wf1"},
    )
    assert r.status_code == 200

    detail = client.get("/api/executions/e-in").json()
    inputs = next(s for s in detail["steps"] if s.get("kind") == "inputs")
    assert inputs["values"]["app_user_id"] == "U1"
    assert inputs["values"]["password"] == "***REDACTED***"

    # 목록 집계는 입력값 엔트리를 제외하고 스텝만 센다
    row = next(e for e in client.get("/api/executions").json()["executions"] if e["execution_id"] == "e-in")
    assert row["step_count"] == 1
    assert row["overall_status"] == "SUCCESS"
    assert row["workflow_id"] == "wf1"
