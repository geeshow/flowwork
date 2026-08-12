"""편집 git 연산 — 브랜치별 worktree로 여러 브랜치를 동시에 편집한다.

데이터 저장소(DATA_DIR = master 체크아웃, 운영)와 별도로, 같은 저장소의
브랜치마다 EDIT_DATA_DIR 하위에 전용 worktree를 둔다:

    {EDIT_DATA_DIR}/develop        ← develop worktree (편집 기본 뷰, 머지 수행)
    {EDIT_DATA_DIR}/feature__x     ← feature/x worktree (수정 모드)

편집 흐름:
  1. develop 뷰(읽기 전용) → feature 브랜치 생성 시 전용 worktree가 만들어진다
  2. 저장 = 그 브랜치 worktree 파일 쓰기 (커밋 전 임시 저장 — 브랜치별로 독립 보존)
  3. stage → commit → push → develop 머지 (develop worktree에서 수행,
     충돌 시 파일별 ours/theirs 제공, 머지 완료 시 feature worktree/브랜치 정리)
  4. develop → master 운영 반영, master vs develop 미반영 목록

원격(push/pull)은 오프라인에서도 동작하도록 best-effort로 처리한다.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

from .config import (
    DATA_DIR,
    EDIT_BASE_BRANCH,
    EDIT_DATA_DIR,
    PROD_BRANCH,
    check_branch_name,
    edit_worktree_path,
)


class GitError(Exception):
    """git 명령 실패 (메시지는 사용자에게 그대로 노출 가능한 수준으로)."""


def _run(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True)


def _git(*args: str, cwd: Path) -> str:
    proc = _run(*args, cwd=cwd)
    if proc.returncode != 0:
        raise GitError((proc.stderr or proc.stdout).strip() or f"git {' '.join(args)} 실패")
    return proc.stdout


def _check_branch(name: str) -> str:
    try:
        return check_branch_name(name)
    except ValueError as e:
        raise GitError(str(e)) from e


def branch_exists(branch: str) -> bool:
    return _run("rev-parse", "-q", "--verify", f"refs/heads/{branch}", cwd=DATA_DIR).returncode == 0


def _migrate_legacy_worktree() -> None:
    """구버전 레이아웃(EDIT_DATA_DIR 자체가 단일 worktree)을 브랜치별 하위 폴더로 이동."""
    if not (EDIT_DATA_DIR / ".git").is_file():
        return
    branch = _git("rev-parse", "--abbrev-ref", "HEAD", cwd=EDIT_DATA_DIR).strip()
    tmp = EDIT_DATA_DIR.parent / (EDIT_DATA_DIR.name + ".migrating")
    _git("worktree", "move", str(EDIT_DATA_DIR), str(tmp), cwd=DATA_DIR)
    EDIT_DATA_DIR.mkdir(parents=True)
    _git("worktree", "move", str(tmp), str(edit_worktree_path(branch)), cwd=DATA_DIR)


def ensure_base() -> None:
    """저장소/브랜치/develop worktree 기본 구성을 보장한다."""
    if not (DATA_DIR / ".git").exists():
        raise GitError(f"데이터 디렉토리가 git 저장소가 아닙니다: {DATA_DIR}")
    _migrate_legacy_worktree()
    if not branch_exists(EDIT_BASE_BRANCH):
        _git("branch", EDIT_BASE_BRANCH, PROD_BRANCH, cwd=DATA_DIR)
    ensure_worktree(EDIT_BASE_BRANCH)


def ensure_worktree(branch: str | None = None) -> Path:
    """브랜치 전용 worktree 경로 (없으면 생성). 브랜치가 없으면 오류."""
    b = _check_branch(branch or EDIT_BASE_BRANCH)
    path = edit_worktree_path(b)
    if (path / ".git").is_file():
        return path
    if not (DATA_DIR / ".git").exists():
        raise GitError(f"데이터 디렉토리가 git 저장소가 아닙니다: {DATA_DIR}")
    _migrate_legacy_worktree()
    if (path / ".git").is_file():
        return path
    if b == EDIT_BASE_BRANCH and not branch_exists(b):
        _git("branch", EDIT_BASE_BRANCH, PROD_BRANCH, cwd=DATA_DIR)
    if not branch_exists(b):
        raise GitError(f"브랜치가 없습니다: {b}")
    path.parent.mkdir(parents=True, exist_ok=True)
    _run("worktree", "prune", cwd=DATA_DIR)  # 지워진 worktree 등록 정리
    _git("worktree", "add", str(path), b, cwd=DATA_DIR)
    return path


def _wt(branch: str | None) -> Path:
    return ensure_worktree(branch)


def is_dirty(branch: str | None = None) -> bool:
    return bool(_git("status", "--porcelain", cwd=_wt(branch)).strip())


def in_merge() -> bool:
    """develop worktree의 머지 진행 여부 (feature 머지는 develop worktree에서 수행)."""
    return _run("rev-parse", "-q", "--verify", "MERGE_HEAD", cwd=_wt(None)).returncode == 0


def list_feature_branches() -> list[str]:
    out = _git("for-each-ref", "--format=%(refname:short)", "refs/heads/", cwd=DATA_DIR)
    skip = {PROD_BRANCH, EDIT_BASE_BRANCH}
    return [b for b in out.splitlines() if b and b not in skip]


def state(branch: str | None = None) -> dict[str, Any]:
    ensure_base()
    b = _check_branch(branch or EDIT_BASE_BRANCH)
    return {
        "branch": b,
        "base_branch": EDIT_BASE_BRANCH,
        "prod_branch": PROD_BRANCH,
        "feature_branches": list_feature_branches(),
        "dirty": is_dirty(b),
        "in_merge": in_merge(),
    }


def create_branch(name: str) -> str:
    """develop에서 feature 브랜치를 만들고 전용 worktree를 준비한다."""
    ensure_base()
    name = _check_branch(name)
    if not name.startswith("feature/"):
        name = f"feature/{name}"
    if branch_exists(name):
        raise GitError(f"이미 있는 브랜치입니다: {name}")
    _git("branch", name, EDIT_BASE_BRANCH, cwd=DATA_DIR)
    ensure_worktree(name)
    return name


# ---------------------------------------------------------------------------
# 파일 상태 — develop 대비 unstaged / staged / committed / pushed
# ---------------------------------------------------------------------------
def _parse_porcelain_z(raw: str) -> list[tuple[str, str, str]]:
    """`status --porcelain -z` → [(X, Y, path)]. rename은 신규 경로 기준."""
    out: list[tuple[str, str, str]] = []
    fields = raw.split("\0")
    i = 0
    while i < len(fields):
        f = fields[i]
        if len(f) < 4:
            i += 1
            continue
        x, y, path = f[0], f[1], f[3:]
        if x in "RC":  # rename/copy: 다음 필드가 원래 경로
            i += 1
        out.append((x, y, path))
        i += 1
    return out


def _diff_names(*args: str, cwd: Path) -> dict[str, str]:
    """`diff --name-status -z <args>` → {path: A|M|D}."""
    raw = _git("diff", "--name-status", "-z", *args, cwd=cwd)
    fields = raw.split("\0")
    out: dict[str, str] = {}
    i = 0
    while i + 1 < len(fields):
        code = fields[i]
        if not code:
            i += 1
            continue
        if code[0] in "RC":  # R100 old new
            out[fields[i + 2]] = "M"
            i += 3
        else:
            out[fields[i + 1]] = code[0]
            i += 2
    return out


def _remote_exists(branch: str) -> bool:
    return _run("rev-parse", "-q", "--verify", f"refs/remotes/origin/{branch}", cwd=DATA_DIR).returncode == 0


def _read_blob(ref: str, path: str, cwd: Path) -> str | None:
    proc = _run("show", f"{ref}:{path}", cwd=cwd)
    return proc.stdout if proc.returncode == 0 else None


def _summarize(path: str, content: str | None) -> dict[str, Any]:
    """데이터 파일 경로 → 표시용 요약.

    워크플로우 파일이면 도메인/업무/이름, API 콜렉션 파일이면 workspace/이름 포함.
    """
    entry: dict[str, Any] = {"path": path, "kind": "file"}
    parts = Path(path).parts
    data: dict[str, Any] = {}
    if content:
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            data = {}
    if parts[0] == "workflows" and len(parts) == 4:
        entry.update(kind="workflow", domain=parts[1], task=parts[2], id=Path(path).stem)
        entry.update(
            id=data.get("id", entry["id"]),
            domain=data.get("domain", entry["domain"]),
            task=data.get("task", entry["task"]),
            name=data.get("name", entry["id"]),
        )
    elif parts[0] == "api-collections" and len(parts) == 3:
        entry.update(
            kind="collection",
            workspace=parts[1],
            id=data.get("id", Path(path).stem),
            name=data.get("name", Path(path).stem),
        )
    return entry


def _content_for(path: str, wt: Path) -> str | None:
    p = wt / path
    if p.exists():
        try:
            return p.read_text(encoding="utf-8")
        except OSError:
            return None
    return _read_blob("HEAD", path, cwd=wt)  # 삭제된 파일은 HEAD 기준으로 요약


def file_states(branch: str | None = None) -> dict[str, Any]:
    """develop 대비 변경 파일 목록과 각 파일의 상태.

    상태 우선순위: unstaged > staged > committed > pushed
      - unstaged: worktree 변경이 아직 stage 안 됨
      - staged: index에 올라감 (커밋 대기)
      - committed: 브랜치에 커밋됨 (origin 미반영)
      - pushed: origin/<branch>까지 반영됨
    """
    b = _check_branch(branch or EDIT_BASE_BRANCH)
    wt = _wt(b)
    states: dict[str, dict[str, Any]] = {}

    def put(path: str, state: str, change: str) -> None:
        if path in states:
            return  # 먼저 넣은(우선순위 높은) 상태 유지
        entry = _summarize(path, _content_for(path, wt))
        entry.update(state=state, change=change)
        states[path] = entry

    # 1) worktree/index (unstaged, staged) — -uall: 미추적 디렉토리도 파일 단위로
    for x, y, path in _parse_porcelain_z(_git("status", "--porcelain", "-uall", "-z", cwd=wt)):
        if y != " " and y != "?":
            put(path, "unstaged", "D" if y == "D" else ("A" if x == "?" or y == "A" else "M"))
        elif y == "?":
            put(path, "unstaged", "A")
        if x not in " ?":
            put(path, "staged", "D" if x == "D" else ("A" if x == "A" else "M"))

    # 2) 커밋된 변경 (develop 머지베이스 대비)
    if b != EDIT_BASE_BRANCH:
        committed = _diff_names(f"{EDIT_BASE_BRANCH}...HEAD", cwd=wt)
        unpushed: set[str] = set(committed)
        if _remote_exists(b):
            unpushed = set(_diff_names(f"refs/remotes/origin/{b}..HEAD", cwd=wt))
        for path, change in committed.items():
            put(path, "committed" if path in unpushed else "pushed", change)

    return {"branch": b, "files": sorted(states.values(), key=lambda e: e["path"])}


# ---------------------------------------------------------------------------
# stage / commit / push — 각 브랜치 worktree에서 수행
# ---------------------------------------------------------------------------
def stage(branch: str | None, paths: list[str] | None = None) -> None:
    wt = _wt(branch)
    if paths:
        _git("add", "--", *paths, cwd=wt)
    else:
        _git("add", "-A", cwd=wt)


def unstage(branch: str | None, paths: list[str] | None = None) -> None:
    wt = _wt(branch)
    if paths:
        _git("restore", "--staged", "--", *paths, cwd=wt)
    else:
        _git("restore", "--staged", ".", cwd=wt)


def discard(branch: str | None, paths: list[str]) -> None:
    """worktree 변경 되돌리기 (미추적 파일은 삭제)."""
    wt = _wt(branch)
    for path in paths:
        p = wt / path
        tracked = _run("ls-files", "--error-unmatch", "--", path, cwd=wt).returncode == 0
        if tracked:
            _git("restore", "--staged", "--worktree", "--", path, cwd=wt)
        elif p.exists():
            p.unlink()


def discard_all(branch: str | None) -> None:
    """해당 브랜치 worktree의 커밋 전 변경 전체 초기화."""
    wt = _wt(branch)
    _git("reset", "--hard", "HEAD", cwd=wt)
    _git("clean", "-fd", cwd=wt)


def _safe_edit_path(wt: Path, path: str) -> Path:
    target = (wt / path).resolve()
    if not target.is_relative_to(wt.resolve()) or ".git" in Path(path).parts:
        raise GitError(f"허용되지 않는 경로입니다: {path!r}")
    return target


def read_file(branch: str | None, path: str) -> str | None:
    target = _safe_edit_path(_wt(branch), path)
    return target.read_text(encoding="utf-8") if target.is_file() else None


def write_file(branch: str | None, path: str, content: str) -> None:
    target = _safe_edit_path(_wt(branch), path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def commit(branch: str | None, message: str, stage_all: bool = False) -> str:
    b = _check_branch(branch or EDIT_BASE_BRANCH)
    if b == EDIT_BASE_BRANCH:
        raise GitError(f"{EDIT_BASE_BRANCH} 브랜치에는 직접 커밋할 수 없습니다. feature 브랜치를 만드세요.")
    wt = _wt(b)
    if stage_all:
        _git("add", "-A", cwd=wt)
    if not _git("diff", "--cached", "--name-only", cwd=wt).strip():
        raise GitError("커밋할 stage된 변경이 없습니다.")
    _git("commit", "-m", message, cwd=wt)
    return _git("rev-parse", "--short", "HEAD", cwd=wt).strip()


def push(branch: str | None) -> dict[str, Any]:
    b = _check_branch(branch or EDIT_BASE_BRANCH)
    proc = _run("push", "-u", "origin", b, cwd=_wt(b))
    if proc.returncode != 0:
        raise GitError((proc.stderr or proc.stdout).strip())
    return {"branch": b, "pushed": True}


def _push_best_effort(branch: str, cwd: Path) -> bool:
    return _run("push", "-u", "origin", branch, cwd=cwd).returncode == 0


def _cleanup_branch(branch: str) -> bool:
    """머지 완료된 feature 브랜치의 worktree/브랜치 제거 (best-effort)."""
    try:
        path = edit_worktree_path(branch)
        if (path / ".git").is_file():
            _git("worktree", "remove", "--force", str(path), cwd=DATA_DIR)
        if branch_exists(branch):
            _git("branch", "-D", branch, cwd=DATA_DIR)
        _run("push", "origin", "--delete", branch, cwd=DATA_DIR)  # 원격은 best-effort
        return True
    except GitError:
        return False


# ---------------------------------------------------------------------------
# develop 머지 + 충돌 해결 — develop worktree에서 수행
# ---------------------------------------------------------------------------
def merge_to_base(branch: str) -> dict[str, Any]:
    """feature 브랜치를 develop에 --no-ff 머지. 충돌 시 develop worktree에 머지 상태 유지."""
    ensure_base()
    b = _check_branch(branch)
    if b in (EDIT_BASE_BRANCH, PROD_BRANCH):
        raise GitError("feature 브랜치만 머지할 수 있습니다.")
    if not branch_exists(b):
        raise GitError(f"브랜치가 없습니다: {b}")
    if in_merge():
        raise GitError("이미 머지가 진행 중입니다. 먼저 완료/중단하세요.")
    if is_dirty(b):
        raise GitError("커밋되지 않은 변경이 있습니다. 먼저 커밋하세요.")
    base_wt = _wt(None)
    if is_dirty(None):
        raise GitError(f"{EDIT_BASE_BRANCH} worktree에 예기치 않은 변경이 있습니다.")

    _run("pull", "--ff-only", "origin", EDIT_BASE_BRANCH, cwd=base_wt)  # 오프라인이면 무시
    proc = _run("merge", "--no-ff", b, "-m", f"merge: {b} → {EDIT_BASE_BRANCH}", cwd=base_wt)
    if proc.returncode != 0:
        if in_merge():
            return {
                "status": "conflict",
                "source_branch": b,
                "files": [c["path"] for c in conflicts()["files"]],
            }
        raise GitError((proc.stderr or proc.stdout).strip())
    return {
        "status": "merged",
        "source_branch": b,
        "pushed": _push_best_effort(EDIT_BASE_BRANCH, base_wt),
        "branch_removed": _cleanup_branch(b),
    }


def conflicts() -> dict[str, Any]:
    """충돌 파일별 base/ours(develop)/theirs(feature) 내용."""
    if not in_merge():
        return {"in_merge": False, "files": [], "source_branch": None}
    wt = _wt(None)
    raw = _git("diff", "--name-only", "-z", "--diff-filter=U", cwd=wt)
    paths = [p for p in raw.split("\0") if p]
    source = _run("name-rev", "--name-only", "MERGE_HEAD", cwd=wt).stdout.strip() or None
    files = []
    for path in paths:
        merged_path = wt / path
        files.append(
            {
                **_summarize(path, _read_blob(":3", path, cwd=wt) or _read_blob(":2", path, cwd=wt)),
                "base": _read_blob(":1", path, cwd=wt),
                "ours": _read_blob(":2", path, cwd=wt),      # develop 쪽
                "theirs": _read_blob(":3", path, cwd=wt),    # feature 쪽
                "merged": merged_path.read_text(encoding="utf-8") if merged_path.exists() else None,
            }
        )
    return {"in_merge": True, "source_branch": source, "files": files}


def resolve_conflict(path: str, content: str) -> None:
    """해결된 내용으로 develop worktree 파일을 덮어쓰고 stage."""
    if not in_merge():
        raise GitError("진행 중인 머지가 없습니다.")
    wt = _wt(None)
    target = _safe_edit_path(wt, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    _git("add", "--", path, cwd=wt)


def merge_continue() -> dict[str, Any]:
    if not in_merge():
        raise GitError("진행 중인 머지가 없습니다.")
    wt = _wt(None)
    remaining = [p for p in _git("diff", "--name-only", "-z", "--diff-filter=U", cwd=wt).split("\0") if p]
    if remaining:
        raise GitError(f"아직 해결되지 않은 충돌이 있습니다: {', '.join(remaining)}")
    source = _run("name-rev", "--name-only", "MERGE_HEAD", cwd=wt).stdout.strip()
    _git("commit", "--no-edit", cwd=wt)
    result = {"status": "merged", "pushed": _push_best_effort(EDIT_BASE_BRANCH, wt)}
    if source and source not in (EDIT_BASE_BRANCH, PROD_BRANCH):
        result["branch_removed"] = _cleanup_branch(source)
    return result


def merge_abort() -> None:
    if not in_merge():
        raise GitError("진행 중인 머지가 없습니다.")
    _git("merge", "--abort", cwd=_wt(None))


# ---------------------------------------------------------------------------
# 운영 반영 — develop을 master(운영 트리)에 머지 + push
# ---------------------------------------------------------------------------
def release_to_prod() -> dict[str, Any]:
    """develop → master 병합(운영 반영). 운영 트리(DATA_DIR, master 체크아웃)에서 수행한다.

    master는 이 경로로만 전진하는 것을 전제로 한다. 충돌이 나면(예: master에
    수동 수정이 끼어든 경우) 병합을 되돌리고 오류를 반환한다 — 수동 해결 대상.
    """
    if _git("status", "--porcelain", cwd=DATA_DIR).strip():
        raise GitError("운영 트리에 커밋되지 않은 변경이 있습니다. 운영 트리는 직접 수정하지 마세요.")
    if not _git("rev-list", "-1", f"{PROD_BRANCH}..{EDIT_BASE_BRANCH}", cwd=DATA_DIR).strip():
        raise GitError(f"운영에 반영할 {EDIT_BASE_BRANCH} 변경이 없습니다.")
    proc = _run(
        "merge", "--no-ff", EDIT_BASE_BRANCH,
        "-m", f"release: {EDIT_BASE_BRANCH} → {PROD_BRANCH}",
        cwd=DATA_DIR,
    )
    if proc.returncode != 0:
        _run("merge", "--abort", cwd=DATA_DIR)
        raise GitError(
            "운영 병합에 충돌이 발생했습니다. develop을 master와 동기화한 뒤 다시 시도하세요: "
            + (proc.stderr or proc.stdout).strip()
        )
    pushed = _run("push", "origin", PROD_BRANCH, cwd=DATA_DIR).returncode == 0
    return {"status": "released", "commit": _git("rev-parse", "--short", PROD_BRANCH, cwd=DATA_DIR).strip(), "pushed": pushed}


# ---------------------------------------------------------------------------
# master vs develop — 운영 미반영 목록
# ---------------------------------------------------------------------------
def pending_for_prod() -> dict[str, Any]:
    """develop에는 있지만 master(운영)에 아직 반영되지 않은 변경 목록."""
    ensure_base()
    changed = _diff_names(f"{PROD_BRANCH}...{EDIT_BASE_BRANCH}", cwd=DATA_DIR)
    files = []
    for path, change in sorted(changed.items()):
        content = _read_blob(EDIT_BASE_BRANCH, path, cwd=DATA_DIR)
        if content is None:  # develop에서 삭제된 파일은 master 기준으로 요약
            content = _read_blob(PROD_BRANCH, path, cwd=DATA_DIR)
        entry = _summarize(path, content)
        entry["change"] = change
        files.append(entry)
    return {"prod_branch": PROD_BRANCH, "base_branch": EDIT_BASE_BRANCH, "files": files}
