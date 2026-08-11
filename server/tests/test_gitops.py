"""편집 git 플로우 통합 테스트 — 실제 git 저장소(bare 원격 포함)로 검증.

master(운영) ← develop ← feature/* 브랜치 체계에서, 브랜치마다 전용 worktree를
두고 동시에 편집한다:
  저장(임시) → stage → commit → push → develop 머지(완료 시 브랜치 정리)
  → 충돌 해결 → 운영 반영(release) → 운영 미반영 목록
"""
import json
import subprocess
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


def _wf(wf_id, name, steps=None):
    return {
        "id": wf_id,
        "domain": "계좌",
        "task": "출금",
        "name": name,
        "baseInputs": [],
        "steps": steps or [{"id": "s1", "order": 1, "name": "조회"}],
    }


def _edit(branch=None):
    return {"source": "edit", **({"branch": branch} if branch else {})}


@pytest.fixture()
def client(monkeypatch):
    """bare 원격 + master 클론(운영 트리) + 브랜치별 편집 worktree 환경."""
    tmp = Path(tempfile.mkdtemp())
    origin = tmp / "origin.git"
    data = tmp / "data"
    _sh("git", "init", "--bare", "-b", "master", str(origin), cwd=tmp)
    _sh("git", "clone", str(origin), str(data), cwd=tmp)
    _sh("git", "config", "user.name", "tester", cwd=data)
    _sh("git", "config", "user.email", "t@example.com", cwd=data)

    # 운영(master) 초기 데이터: 워크플로우 1건
    seed = data / "workflows" / "계좌" / "출금" / "wf_base.json"
    seed.parent.mkdir(parents=True)
    seed.write_text(json.dumps(_wf("wf_base", "기본 출금"), ensure_ascii=False, indent=2), encoding="utf-8")
    _sh("git", "add", "-A", cwd=data)
    _sh("git", "commit", "-m", "seed", cwd=data)
    _sh("git", "push", "-u", "origin", "master", cwd=data)

    monkeypatch.setenv("FLOWWORK_DATA_DIR", str(data))
    monkeypatch.setenv("FLOWWORK_EDIT_DATA_DIR", str(data) + "-edit")

    import importlib

    import app.catalog as catalog
    import app.collections as collections
    import app.config as config
    import app.gitops as gitops
    import app.storage as storage
    import main

    importlib.reload(config)
    importlib.reload(storage)
    importlib.reload(collections)
    importlib.reload(catalog)
    importlib.reload(gitops)
    importlib.reload(main)
    with TestClient(main.app) as c:
        yield c


def _states(client, branch):
    return {f["path"]: f["state"] for f in client.get("/api/edit/status", params={"branch": branch}).json()["files"]}


def test_base_worktree_auto_created(client):
    st = client.get("/api/edit/state").json()
    assert st["branch"] == "develop"
    assert st["feature_branches"] == []
    assert st["dirty"] is False and st["in_merge"] is False
    # develop worktree에서 운영 데이터가 그대로 보인다
    listing = client.get("/api/workflows", params=_edit()).json()["workflows"]
    assert [w["id"] for w in listing] == ["wf_base"]


def test_commit_on_develop_rejected(client):
    resp = client.post("/api/edit/commit", json={"message": "nope"})
    assert resp.status_code == 409


def test_full_edit_flow_states_merge_release(client):
    # 수정 모드: feature 브랜치 생성 (전용 worktree)
    b = client.post("/api/edit/branches", json={"name": "출금한도"}).json()["branch"]
    assert b == "feature/출금한도"

    # 저장 = 브랜치 worktree 임시 저장 → unstaged
    client.put("/api/workflows/wf_new", json=_wf("wf_new", "한도 출금"), params=_edit(b))
    path = "workflows/계좌/출금/wf_new.json"
    assert _states(client, b)[path] == "unstaged"
    # develop worktree에는 보이지 않는다 (브랜치 격리)
    assert client.get("/api/workflows/wf_new", params=_edit()).status_code == 404

    # stage → staged → commit → committed → push → pushed
    client.post("/api/edit/stage", json={"branch": b, "paths": [path]})
    assert _states(client, b)[path] == "staged"
    assert client.post("/api/edit/commit", json={"branch": b, "message": "한도 출금 추가"}).status_code == 200
    assert _states(client, b)[path] == "committed"
    assert client.post("/api/edit/push", json={"branch": b}).json()["pushed"] is True
    assert _states(client, b)[path] == "pushed"

    # develop 머지 → 완료 시 feature 브랜치/worktree 정리
    merged = client.post("/api/edit/merge", json={"branch": b}).json()
    assert merged["status"] == "merged" and merged["branch_removed"] is True
    assert client.get("/api/edit/state").json()["feature_branches"] == []
    assert client.get("/api/workflows/wf_new", params=_edit()).status_code == 200

    # 운영(master)에는 아직 없음 → 미반영 목록 → 운영 반영
    assert client.get("/api/workflows/wf_new").status_code == 404
    pending = client.get("/api/edit/pending").json()["files"]
    assert [f["path"] for f in pending] == [path]
    r = client.post("/api/edit/release").json()
    assert r["status"] == "released" and r["pushed"] is True
    assert client.get("/api/workflows/wf_new").status_code == 200
    assert client.get("/api/edit/pending").json()["files"] == []


def test_concurrent_branches_are_isolated(client):
    """두 브랜치를 동시에 편집 — worktree가 분리되어 서로 영향 없다."""
    a = client.post("/api/edit/branches", json={"name": "a"}).json()["branch"]
    b = client.post("/api/edit/branches", json={"name": "b"}).json()["branch"]

    client.put("/api/workflows/wf_a", json=_wf("wf_a", "A 작업"), params=_edit(a))
    client.put("/api/workflows/wf_b", json=_wf("wf_b", "B 작업"), params=_edit(b))

    # 각 브랜치 worktree에는 자기 변경만 보인다
    ids_a = {w["id"] for w in client.get("/api/workflows", params=_edit(a)).json()["workflows"]}
    ids_b = {w["id"] for w in client.get("/api/workflows", params=_edit(b)).json()["workflows"]}
    assert "wf_a" in ids_a and "wf_b" not in ids_a
    assert "wf_b" in ids_b and "wf_a" not in ids_b
    assert set(_states(client, a)) == {"workflows/계좌/출금/wf_a.json"}
    assert set(_states(client, b)) == {"workflows/계좌/출금/wf_b.json"}

    # a를 커밋·머지해도 b의 커밋 전 변경은 그대로 유지
    client.post("/api/edit/commit", json={"branch": a, "message": "A"})
    assert client.post("/api/edit/merge", json={"branch": a}).json()["status"] == "merged"
    assert _states(client, b)["workflows/계좌/출금/wf_b.json"] == "unstaged"
    # b worktree는 develop보다 뒤처진 분기점 기준이므로 wf_a는 아직 안 보인다
    assert client.get("/api/workflows/wf_a", params=_edit(b)).status_code == 404


def test_merge_conflict_resolve_flow(client):
    base_path = "workflows/계좌/출금/wf_base.json"

    # 같은 develop 시점에서 두 브랜치 분기, 같은 파일을 다르게 수정
    a = client.post("/api/edit/branches", json={"name": "cf-a"}).json()["branch"]
    b = client.post("/api/edit/branches", json={"name": "cf-b"}).json()["branch"]
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "출금 A안"), params=_edit(a))
    client.post("/api/edit/commit", json={"branch": a, "message": "A안"})
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "출금 B안"), params=_edit(b))
    client.post("/api/edit/commit", json={"branch": b, "message": "B안"})

    # a 머지 성공 → b 머지 시 충돌
    assert client.post("/api/edit/merge", json={"branch": a}).json()["status"] == "merged"
    merged = client.post("/api/edit/merge", json={"branch": b}).json()
    assert merged["status"] == "conflict"
    assert merged["files"] == [base_path]
    assert client.get("/api/edit/state").json()["in_merge"] is True

    # 충돌 상세: ours(develop)=A안, theirs(feature/cf-b)=B안
    conf = client.get("/api/edit/conflicts").json()
    file = conf["files"][0]
    assert json.loads(file["ours"])["name"] == "출금 A안"
    assert json.loads(file["theirs"])["name"] == "출금 B안"
    assert "<<<<<<<" in file["merged"]

    # 머지 중 다른 브랜치 편집은 여전히 가능 (동시성)
    c = client.post("/api/edit/branches", json={"name": "cf-c"}).json()["branch"]
    client.put("/api/workflows/wf_c", json=_wf("wf_c", "C 작업"), params=_edit(c))
    assert _states(client, c)["workflows/계좌/출금/wf_c.json"] == "unstaged"

    # 해결 → 머지 계속 → 소스 브랜치 정리
    resolved = json.dumps(_wf("wf_base", "출금 AB 병합안"), ensure_ascii=False, indent=2)
    client.post("/api/edit/conflicts/resolve", json={"path": base_path, "content": resolved})
    done = client.post("/api/edit/merge/continue").json()
    assert done["status"] == "merged" and done.get("branch_removed") is True
    assert client.get("/api/workflows/wf_base", params=_edit()).json()["name"] == "출금 AB 병합안"
    assert client.get("/api/edit/state").json()["in_merge"] is False
    assert "feature/cf-b" not in client.get("/api/edit/state").json()["feature_branches"]


def test_merge_abort_restores(client):
    a = client.post("/api/edit/branches", json={"name": "x"}).json()["branch"]
    b = client.post("/api/edit/branches", json={"name": "y"}).json()["branch"]
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "X안"), params=_edit(a))
    client.post("/api/edit/commit", json={"branch": a, "message": "X"})
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "Y안"), params=_edit(b))
    client.post("/api/edit/commit", json={"branch": b, "message": "Y"})
    assert client.post("/api/edit/merge", json={"branch": a}).json()["status"] == "merged"
    assert client.post("/api/edit/merge", json={"branch": b}).json()["status"] == "conflict"

    assert client.post("/api/edit/merge/abort").json()["status"] == "aborted"
    st = client.get("/api/edit/state").json()
    assert st["in_merge"] is False
    # abort 후 develop은 X안 그대로, y 브랜치는 남아있다
    assert client.get("/api/workflows/wf_base", params=_edit()).json()["name"] == "X안"
    assert "feature/y" in st["feature_branches"]


def test_uncommitted_merge_blocked(client):
    b = client.post("/api/edit/branches", json={"name": "dirty"}).json()["branch"]
    client.put("/api/workflows/wf_d", json=_wf("wf_d", "임시"), params=_edit(b))
    assert client.post("/api/edit/merge", json={"branch": b}).status_code == 409
    # 임시 저장은 브랜치 worktree에 그대로 남는다
    assert client.get("/api/workflows/wf_d", params=_edit(b)).status_code == 200
