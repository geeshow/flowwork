"""편집 git 플로우 통합 테스트 — 실제 git 저장소(bare 원격 포함)로 검증.

master(운영) ← develop ← feature/* 브랜치 체계에서:
  저장(임시) → stage → commit → push → develop 머지 → 충돌 해결 → 운영 미반영 목록
"""
import json
import subprocess
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

EDIT = {"source": "edit"}


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


@pytest.fixture()
def client(monkeypatch):
    """bare 원격 + master 클론(운영 트리) + 편집 worktree 환경."""
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


def _states(client):
    return {f["path"]: f["state"] for f in client.get("/api/edit/status").json()["files"]}


def test_worktree_auto_created_with_develop(client):
    st = client.get("/api/edit/state").json()
    assert st["current_branch"] == "develop"
    assert st["feature_branches"] == []
    assert st["dirty"] is False
    # 편집 worktree에서 운영 데이터가 그대로 보인다
    listing = client.get("/api/workflows", params=EDIT).json()["workflows"]
    assert [w["id"] for w in listing] == ["wf_base"]


def test_commit_on_develop_rejected(client):
    client.get("/api/edit/state")  # worktree 생성
    client.put("/api/workflows/wf_x", json=_wf("wf_x", "임시"), params=EDIT)
    resp = client.post("/api/edit/commit", json={"message": "nope"})
    assert resp.status_code == 409
    client.post("/api/edit/discard", json={"paths": ["workflows/계좌/출금/wf_x.json"]})


def test_full_edit_flow_states_and_merge(client):
    # 수정 모드 진입: feature 브랜치 생성
    r = client.post("/api/edit/branches", json={"name": "출금한도"})
    assert r.json()["branch"] == "feature/출금한도"

    # 저장 = 로컬 임시 저장 → unstaged
    client.put("/api/workflows/wf_new", json=_wf("wf_new", "한도 출금"), params=EDIT)
    path = "workflows/계좌/출금/wf_new.json"
    assert _states(client)[path] == "unstaged"

    # stage → staged
    client.post("/api/edit/stage", json={"paths": [path]})
    assert _states(client)[path] == "staged"

    # commit → committed
    assert client.post("/api/edit/commit", json={"message": "한도 출금 추가"}).status_code == 200
    assert _states(client)[path] == "committed"

    # push → pushed
    assert client.post("/api/edit/push").json()["pushed"] is True
    assert _states(client)[path] == "pushed"

    # develop 머지 → 충돌 없음, 편집 목록(develop)에 반영
    merged = client.post("/api/edit/merge").json()
    assert merged["status"] == "merged"
    assert client.get("/api/edit/state").json()["current_branch"] == "develop"
    ids = [w["id"] for w in client.get("/api/workflows", params=EDIT).json()["workflows"]]
    assert "wf_new" in ids

    # 운영(master)에는 아직 없음 → 미반영 목록에 나타난다
    assert client.get("/api/workflows/wf_new").status_code == 404
    pending = client.get("/api/edit/pending").json()["files"]
    assert [f["path"] for f in pending] == [path]
    assert pending[0]["change"] == "A"
    assert pending[0]["name"] == "한도 출금"


def test_merge_conflict_resolve_flow(client):
    base_path = "workflows/계좌/출금/wf_base.json"

    # feature/a: 이름 변경 후 develop 머지
    client.post("/api/edit/branches", json={"name": "a"})
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "출금 A안"), params=EDIT)
    client.post("/api/edit/commit", json={"message": "A안"})
    assert client.post("/api/edit/merge").json()["status"] == "merged"

    # feature/b: master 기준이 아닌 develop에서 분기해도, 같은 파일을 다르게 수정
    client.post("/api/edit/branches", json={"name": "b"})
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "출금 B안"), params=EDIT)
    client.post("/api/edit/commit", json={"message": "B안"})

    # develop을 A안과 다른 상태로 진행시키기 위해 feature/c에서 한 번 더 수정·머지
    client.post("/api/edit/checkout", json={"name": "develop"})
    client.post("/api/edit/branches", json={"name": "c"})
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "출금 C안"), params=EDIT)
    client.post("/api/edit/commit", json={"message": "C안"})
    assert client.post("/api/edit/merge").json()["status"] == "merged"

    # feature/b 머지 → 충돌
    client.post("/api/edit/checkout", json={"name": "feature/b"})
    merged = client.post("/api/edit/merge").json()
    assert merged["status"] == "conflict"
    assert merged["files"] == [base_path]

    # 충돌 상세: ours(develop)=C안, theirs(feature/b)=B안
    conf = client.get("/api/edit/conflicts").json()
    assert conf["in_merge"] is True
    file = conf["files"][0]
    assert json.loads(file["ours"])["name"] == "출금 C안"
    assert json.loads(file["theirs"])["name"] == "출금 B안"
    assert "<<<<<<<" in file["merged"]

    # 해결(수동 병합 내용 작성) → 머지 계속
    resolved = json.dumps(_wf("wf_base", "출금 BC 병합안"), ensure_ascii=False, indent=2)
    assert client.post(
        "/api/edit/conflicts/resolve", json={"path": base_path, "content": resolved}
    ).status_code == 200
    assert client.post("/api/edit/merge/continue").json()["status"] == "merged"

    got = client.get("/api/workflows/wf_base", params=EDIT).json()
    assert got["name"] == "출금 BC 병합안"
    assert client.get("/api/edit/state").json()["in_merge"] is False


def test_merge_abort_restores(client):
    # 충돌 상황 구성 (위 테스트와 동일 패턴 축약)
    client.post("/api/edit/branches", json={"name": "x"})
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "X안"), params=EDIT)
    client.post("/api/edit/commit", json={"message": "X"})
    client.post("/api/edit/checkout", json={"name": "develop"})
    client.post("/api/edit/branches", json={"name": "y"})
    client.put("/api/workflows/wf_base", json=_wf("wf_base", "Y안"), params=EDIT)
    client.post("/api/edit/commit", json={"message": "Y"})
    assert client.post("/api/edit/merge").json()["status"] == "merged"
    client.post("/api/edit/checkout", json={"name": "feature/x"})
    assert client.post("/api/edit/merge").json()["status"] == "conflict"

    assert client.post("/api/edit/merge/abort").json()["status"] == "aborted"
    st = client.get("/api/edit/state").json()
    assert st["in_merge"] is False
    # abort 후 develop은 Y안 그대로
    assert client.get("/api/workflows/wf_base", params=EDIT).json()["name"] == "Y안"


def test_switch_with_dirty_tree_blocked(client):
    client.post("/api/edit/branches", json={"name": "dirty"})
    client.put("/api/workflows/wf_tmp", json=_wf("wf_tmp", "임시저장"), params=EDIT)
    # 커밋 전 브랜치 이동 불가 (임시 저장 보호)
    assert client.post("/api/edit/checkout", json={"name": "develop"}).status_code == 409
    # 임시 저장은 그대로 남아 있다
    assert client.get("/api/workflows/wf_tmp", params=EDIT).status_code == 200
