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

    import app.config as config
    import app.storage as storage
    import main

    importlib.reload(config)
    importlib.reload(storage)
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


def test_workflow_crud_roundtrip(client):
    wf = {
        "id": "wf_demo",
        "group": "payments",
        "name": "데모",
        "steps": [{"id": "step_1", "order": 1, "name": "조회"}],
    }
    assert client.put("/api/workflows/payments/wf_demo", json=wf).json() == {"status": "saved"}

    got = client.get("/api/workflows/payments/wf_demo").json()
    assert got["name"] == "데모"

    listing = client.get("/api/workflows").json()["workflows"]
    assert any(w["id"] == "wf_demo" for w in listing)

    assert client.delete("/api/workflows/payments/wf_demo").json() == {"status": "deleted"}
    assert client.get("/api/workflows/payments/wf_demo").status_code == 404


def test_workflow_rejects_unsafe_group(client):
    wf = {"id": "x", "group": "..", "name": "x", "steps": []}
    resp = client.put("/api/workflows/../wf", json=wf)
    assert resp.status_code in (400, 404)


def test_catalog_search(client):
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
