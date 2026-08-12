import os
import tempfile

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(monkeypatch):
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("FLOWWORK_DATA_DIR", tmp)
    monkeypatch.setenv("FLOWWORK_EDIT_DATA_DIR", tmp + "-edit")
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


# 등록/수정/삭제는 편집 worktree(source=edit)에서만 허용된다.
EDIT = {"source": "edit"}


def test_workflow_crud_roundtrip(client):
    wf = _wf("wf_demo", "계좌", "사용자관리", "데모")
    saved = client.put("/api/workflows/wf_demo", json=wf, params=EDIT).json()
    assert saved["status"] == "saved" and saved["version"]

    got = client.get("/api/workflows/wf_demo", params=EDIT).json()
    assert got["name"] == "데모"
    assert got["domain"] == "계좌" and got["task"] == "사용자관리"

    listing = client.get("/api/workflows", params=EDIT).json()["workflows"]
    assert any(w["id"] == "wf_demo" for w in listing)

    assert client.delete("/api/workflows/wf_demo", params=EDIT).json()["status"] == "deleted"
    assert client.get("/api/workflows/wf_demo", params=EDIT).status_code == 404


def test_workflow_write_to_prod_rejected(client):
    """운영(prod) 데이터는 API로 직접 수정할 수 없다 — git 편집 플로우만 허용."""
    wf = _wf("wf_p", "계좌", "개설", "운영쓰기")
    assert client.put("/api/workflows/wf_p", json=wf, params={"source": "prod"}).status_code == 403
    assert client.delete("/api/workflows/wf_p", params={"source": "prod"}).status_code == 403
    assert client.put("/api/domains/계좌", json={"color": "#f2b544"}, params={"source": "prod"}).status_code == 403


def test_workflow_edit_save_invisible_in_prod(client):
    """편집 worktree 저장은 운영(prod) 목록에 나타나지 않는다 (트리 분리)."""
    client.put("/api/workflows/wf_e", json=_wf("wf_e", "계좌", "개설", "편집만"), params=EDIT)
    assert client.get("/api/workflows/wf_e", params=EDIT).status_code == 200
    assert client.get("/api/workflows/wf_e").status_code == 404
    assert client.get("/api/workflows").json()["workflows"] == []


def test_workflow_save_version_conflict(client):
    """동일 브랜치 동시 저장 — 낙관적 잠금(파일 해시 버전)으로 충돌을 감지한다."""
    client.put("/api/workflows/wf_v", json=_wf("wf_v", "계좌", "개설", "버전"), params=EDIT)

    # 두 사용자가 같은 버전을 조회
    a = client.get("/api/workflows/wf_v", params=EDIT).json()
    b = client.get("/api/workflows/wf_v", params=EDIT).json()
    assert a["version"] and a["version"] == b["version"]

    # A 먼저 저장 → 새 버전 반환
    a["description"] = "A 수정"
    ra = client.put("/api/workflows/wf_v", json=a, params=EDIT)
    assert ra.status_code == 200 and ra.json()["version"] != a["version"]

    # B는 이전 버전 기준 → 409 version_conflict (서버 현재 버전 포함)
    b["description"] = "B 수정"
    rb = client.put("/api/workflows/wf_v", json=b, params=EDIT)
    assert rb.status_code == 409
    detail = rb.json()["detail"]
    assert detail["code"] == "version_conflict"
    assert detail["current_version"] == ra.json()["version"]
    # 충돌로 저장이 거부됐으니 A의 내용이 유지된다
    assert client.get("/api/workflows/wf_v", params=EDIT).json()["description"] == "A 수정"

    # 강제 저장(덮어쓰기)은 허용
    assert client.put("/api/workflows/wf_v", json=b, params={**EDIT, "force": "true"}).status_code == 200
    assert client.get("/api/workflows/wf_v", params=EDIT).json()["description"] == "B 수정"

    # 조회 후 상대가 삭제한 경우도 충돌
    c = client.get("/api/workflows/wf_v", params=EDIT).json()
    client.delete("/api/workflows/wf_v", params=EDIT)
    rc = client.put("/api/workflows/wf_v", json=c, params=EDIT)
    assert rc.status_code == 409
    assert rc.json()["detail"]["current_version"] is None

    # 버전 없이 저장(신규 등록 경로)은 검사 없이 통과
    fresh = _wf("wf_v", "계좌", "개설", "버전")
    assert client.put("/api/workflows/wf_v", json=fresh, params=EDIT).status_code == 200


def test_workflow_name_unique_within_domain_task(client):
    client.put("/api/workflows/id_a", json=_wf("id_a", "계좌", "개설", "계좌 개설"), params=EDIT)
    # 같은 도메인/업무에 같은 이름 → 409
    dup = client.put("/api/workflows/id_b", json=_wf("id_b", "계좌", "개설", "계좌 개설"), params=EDIT)
    assert dup.status_code == 409
    # 다른 업무면 같은 이름 허용
    ok = client.put("/api/workflows/id_c", json=_wf("id_c", "계좌", "폐쇄", "계좌 개설"), params=EDIT)
    assert ok.status_code == 200


def test_workflow_moves_file_on_domain_change(client):
    client.put("/api/workflows/mv1", json=_wf("mv1", "계좌", "개설", "이동테스트"), params=EDIT)
    # 도메인/업무를 바꿔 저장 → id는 그대로, 경로 이동
    client.put("/api/workflows/mv1", json=_wf("mv1", "매매", "주문", "이동테스트"), params=EDIT)
    got = client.get("/api/workflows/mv1", params=EDIT).json()
    assert got["domain"] == "매매" and got["task"] == "주문"
    # 목록에 중복 없이 한 건만
    listing = client.get("/api/workflows", params=EDIT).json()["workflows"]
    assert len([w for w in listing if w["id"] == "mv1"]) == 1


def test_workflow_rejects_unsafe_segment(client):
    wf = _wf("x", "..", "t", "x")
    resp = client.put("/api/workflows/x", json=wf, params=EDIT)
    assert resp.status_code == 400


def test_domain_color_roundtrip(client):
    # 기본은 빈 매핑
    assert client.get("/api/domains", params=EDIT).json() == {"colors": {}}
    # 유효한 hex 저장 후 조회
    assert client.put("/api/domains/계좌", json={"color": "#f2b544"}, params=EDIT).json()["status"] == "saved"
    assert client.get("/api/domains", params=EDIT).json()["colors"] == {"계좌": "#f2b544"}
    # 덮어쓰기
    client.put("/api/domains/계좌", json={"color": "#4c8dff"}, params=EDIT)
    assert client.get("/api/domains", params=EDIT).json()["colors"]["계좌"] == "#4c8dff"


def test_domain_color_rejects_non_hex(client):
    assert client.put("/api/domains/계좌", json={"color": "blue"}, params=EDIT).status_code == 400
    assert client.put("/api/domains/계좌", json={"color": "#12"}, params=EDIT).status_code == 400
    # 잘못된 값 저장 실패 후에도 매핑은 비어 있어야 한다
    assert client.get("/api/domains", params=EDIT).json() == {"colors": {}}


def test_catalog_search_indexes_api_collections(client):
    """워크플로우용 API 인덱스는 API 콜렉션에 등록된 요청만 노출한다.

    콜렉션도 브랜치 편집 플로우를 따르므로 쓰기/조회 모두 source=edit로 검증한다.
    """
    assert client.get("/api/catalog/search", params=EDIT).json()["results"] == []  # 콜렉션 없음

    client.post("/api/apic/workspaces", json={"name": "payments"}, params=EDIT)
    doc = client.post("/api/apic/workspaces/payments/collections", json={"name": "정산"}, params=EDIT).json()
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
    client.put(f"/api/apic/workspaces/payments/collections/{doc['id']}", json=doc, params=EDIT)

    resp = client.get("/api/catalog/search", params={**EDIT, "q": "정산"}).json()
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
