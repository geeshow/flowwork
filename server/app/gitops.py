"""편집 worktree의 git 연산 — 브랜치/상태/커밋/머지/충돌 해결.

데이터 저장소(DATA_DIR = master 체크아웃, 운영)와 별도로, 같은 저장소의
develop/feature 브랜치를 체크아웃한 편집 worktree(EDIT_DATA_DIR)를 다룬다.

편집 흐름:
  1. develop 뷰(읽기 전용) → feature 브랜치 생성/선택으로 수정 모드 진입
  2. 저장 = worktree 파일 쓰기 (커밋 전 로컬 임시 저장, 서버 재시작에도 유지)
  3. stage → commit → push → develop 머지 (충돌 시 파일별 ours/theirs 제공)
  4. master vs develop 비교로 운영 미반영 목록 제공

원격(push/pull)은 오프라인에서도 동작하도록 best-effort로 처리한다.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any

from .config import DATA_DIR, EDIT_BASE_BRANCH, EDIT_DATA_DIR, PROD_BRANCH

# 브랜치명: 영문/숫자/한글/-/_/./ 만 허용, '..'과 선행 '-' 금지 (git 옵션 주입 방지)
_BRANCH_RE = re.compile(r"^[\w가-힣][\w가-힣./-]*$", re.UNICODE)


class GitError(Exception):
    """git 명령 실패 (메시지는 사용자에게 그대로 노출 가능한 수준으로)."""


def _run(*args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd or EDIT_DATA_DIR),
        capture_output=True,
        text=True,
    )


def _git(*args: str, cwd: Path | None = None) -> str:
    proc = _run(*args, cwd=cwd)
    if proc.returncode != 0:
        raise GitError((proc.stderr or proc.stdout).strip() or f"git {' '.join(args)} 실패")
    return proc.stdout


def _check_branch_name(name: str) -> str:
    if not _BRANCH_RE.match(name) or ".." in name:
        raise GitError(f"허용되지 않는 브랜치 이름입니다: {name!r}")
    return name


def ensure_ready() -> None:
    """편집 worktree가 없으면 develop 브랜치와 함께 만든다."""
    if not (DATA_DIR / ".git").exists():
        raise GitError(f"데이터 디렉토리가 git 저장소가 아닙니다: {DATA_DIR}")
    if (EDIT_DATA_DIR / ".git").exists():
        return
    if not _git("branch", "--list", EDIT_BASE_BRANCH, cwd=DATA_DIR).strip():
        _git("branch", EDIT_BASE_BRANCH, PROD_BRANCH, cwd=DATA_DIR)
    _git("worktree", "add", str(EDIT_DATA_DIR), EDIT_BASE_BRANCH, cwd=DATA_DIR)


# ---------------------------------------------------------------------------
# 브랜치
# ---------------------------------------------------------------------------
def current_branch() -> str:
    return _git("rev-parse", "--abbrev-ref", "HEAD").strip()


def in_merge() -> bool:
    return _run("rev-parse", "-q", "--verify", "MERGE_HEAD").returncode == 0


def is_dirty() -> bool:
    return bool(_git("status", "--porcelain").strip())


def list_feature_branches() -> list[str]:
    out = _git("for-each-ref", "--format=%(refname:short)", "refs/heads/")
    skip = {PROD_BRANCH, EDIT_BASE_BRANCH}
    return [b for b in out.splitlines() if b and b not in skip]


def state() -> dict[str, Any]:
    return {
        "current_branch": current_branch(),
        "base_branch": EDIT_BASE_BRANCH,
        "prod_branch": PROD_BRANCH,
        "feature_branches": list_feature_branches(),
        "dirty": is_dirty(),
        "in_merge": in_merge(),
    }


def create_branch(name: str) -> str:
    """develop에서 feature 브랜치를 만들고 전환한다."""
    if in_merge():
        raise GitError("머지 진행 중에는 브랜치를 만들 수 없습니다. 머지를 완료/중단하세요.")
    name = _check_branch_name(name)
    if not name.startswith("feature/"):
        name = f"feature/{name}"
    if is_dirty() and current_branch() != EDIT_BASE_BRANCH:
        raise GitError("커밋되지 않은 변경이 있습니다. 먼저 커밋하거나 되돌리세요.")
    _git("switch", "-c", name, EDIT_BASE_BRANCH)
    return name


def switch_branch(branch: str) -> str:
    if in_merge():
        raise GitError("머지 진행 중에는 브랜치를 바꿀 수 없습니다. 머지를 완료/중단하세요.")
    branch = _check_branch_name(branch)
    if branch != current_branch() and is_dirty():
        raise GitError("커밋되지 않은 변경이 있습니다. 먼저 커밋하거나 되돌리세요.")
    _git("switch", branch)
    return branch


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


def _diff_names(*args: str) -> dict[str, str]:
    """`diff --name-status -z <args>` → {path: A|M|D}."""
    raw = _git("diff", "--name-status", "-z", *args)
    fields = [f for f in raw.split("\0")]
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
    return _run("rev-parse", "-q", "--verify", f"refs/remotes/origin/{branch}").returncode == 0


def _read_blob(ref: str, path: str) -> str | None:
    proc = _run("show", f"{ref}:{path}")
    return proc.stdout if proc.returncode == 0 else None


def _summarize(path: str, content: str | None) -> dict[str, Any]:
    """데이터 파일 경로 → 표시용 요약. 워크플로우 파일이면 도메인/업무/이름 포함."""
    entry: dict[str, Any] = {"path": path, "kind": "file"}
    parts = Path(path).parts
    if parts[0] == "workflows" and len(parts) == 4:
        entry.update(kind="workflow", domain=parts[1], task=parts[2], id=Path(path).stem)
        if content:
            try:
                data = json.loads(content)
                entry.update(
                    id=data.get("id", entry["id"]),
                    domain=data.get("domain", entry["domain"]),
                    task=data.get("task", entry["task"]),
                    name=data.get("name", entry["id"]),
                )
            except json.JSONDecodeError:
                entry["name"] = entry["id"]
        else:
            entry["name"] = entry["id"]
    return entry


def _content_for(path: str) -> str | None:
    p = EDIT_DATA_DIR / path
    if p.exists():
        try:
            return p.read_text(encoding="utf-8")
        except OSError:
            return None
    return _read_blob("HEAD", path)  # 삭제된 파일은 HEAD 기준으로 요약


def file_states() -> dict[str, Any]:
    """develop 대비 변경 파일 목록과 각 파일의 상태.

    상태 우선순위: unstaged > staged > committed > pushed
      - unstaged: worktree 변경이 아직 stage 안 됨
      - staged: index에 올라감 (커밋 대기)
      - committed: 현재 브랜치에 커밋됨 (origin 미반영)
      - pushed: origin/<branch>까지 반영됨
    """
    branch = current_branch()
    states: dict[str, dict[str, Any]] = {}

    def put(path: str, state: str, change: str) -> None:
        if path in states:
            return  # 먼저 넣은(우선순위 높은) 상태 유지
        entry = _summarize(path, _content_for(path))
        entry.update(state=state, change=change)
        states[path] = entry

    # 1) worktree/index (unstaged, staged)
    for x, y, path in _parse_porcelain_z(_git("status", "--porcelain", "-z")):
        if y != " " and y != "?":
            put(path, "unstaged", "D" if y == "D" else ("A" if x == "?" or y == "A" else "M"))
        elif y == "?":
            put(path, "unstaged", "A")
        if x not in " ?":
            put(path, "staged", "D" if x == "D" else ("A" if x == "A" else "M"))

    # 2) 커밋된 변경 (develop 머지베이스 대비)
    if branch != EDIT_BASE_BRANCH:
        committed = _diff_names(f"{EDIT_BASE_BRANCH}...HEAD")
        unpushed: set[str] = set(committed)
        if _remote_exists(branch):
            unpushed = set(_diff_names(f"refs/remotes/origin/{branch}..HEAD"))
        for path, change in committed.items():
            put(path, "committed" if path in unpushed else "pushed", change)

    return {"branch": branch, "files": sorted(states.values(), key=lambda e: e["path"])}


# ---------------------------------------------------------------------------
# stage / commit / push
# ---------------------------------------------------------------------------
def stage(paths: list[str] | None = None) -> None:
    if paths:
        _git("add", "--", *paths)
    else:
        _git("add", "-A")


def unstage(paths: list[str] | None = None) -> None:
    if paths:
        _git("restore", "--staged", "--", *paths)
    else:
        _git("restore", "--staged", ".")


def discard(paths: list[str]) -> None:
    """worktree 변경 되돌리기 (미추적 파일은 삭제)."""
    for path in paths:
        p = EDIT_DATA_DIR / path
        tracked = _run("ls-files", "--error-unmatch", "--", path).returncode == 0
        if tracked:
            _git("restore", "--staged", "--worktree", "--", path)
        elif p.exists():
            p.unlink()


def commit(message: str, stage_all: bool = False) -> str:
    if current_branch() == EDIT_BASE_BRANCH and not in_merge():
        raise GitError(f"{EDIT_BASE_BRANCH} 브랜치에는 직접 커밋할 수 없습니다. feature 브랜치를 만드세요.")
    if stage_all:
        _git("add", "-A")
    if not _git("diff", "--cached", "--name-only").strip():
        raise GitError("커밋할 stage된 변경이 없습니다.")
    _git("commit", "-m", message)
    return _git("rev-parse", "--short", "HEAD").strip()


def push() -> dict[str, Any]:
    branch = current_branch()
    proc = _run("push", "-u", "origin", branch)
    if proc.returncode != 0:
        raise GitError((proc.stderr or proc.stdout).strip())
    return {"branch": branch, "pushed": True}


def _push_best_effort(branch: str) -> bool:
    return _run("push", "-u", "origin", branch).returncode == 0


# ---------------------------------------------------------------------------
# develop 머지 + 충돌 해결
# ---------------------------------------------------------------------------
def merge_to_base() -> dict[str, Any]:
    """현재 feature 브랜치를 develop에 --no-ff 머지. 충돌 시 머지 상태 유지."""
    branch = current_branch()
    if in_merge():
        raise GitError("이미 머지가 진행 중입니다.")
    if branch == EDIT_BASE_BRANCH or branch == PROD_BRANCH:
        raise GitError("feature 브랜치에서만 머지를 시작할 수 있습니다.")
    if is_dirty():
        raise GitError("커밋되지 않은 변경이 있습니다. 먼저 커밋하세요.")

    _git("switch", EDIT_BASE_BRANCH)
    _run("pull", "--ff-only", "origin", EDIT_BASE_BRANCH)  # 오프라인이면 무시
    proc = _run("merge", "--no-ff", branch, "-m", f"merge: {branch} → {EDIT_BASE_BRANCH}")
    if proc.returncode != 0:
        if in_merge():
            return {
                "status": "conflict",
                "source_branch": branch,
                "files": [c["path"] for c in conflicts()["files"]],
            }
        _git("switch", branch)  # 머지가 시작조차 못 한 경우 원위치
        raise GitError((proc.stderr or proc.stdout).strip())
    return {
        "status": "merged",
        "source_branch": branch,
        "pushed": _push_best_effort(EDIT_BASE_BRANCH),
    }


def conflicts() -> dict[str, Any]:
    """충돌 파일별 base/ours(develop)/theirs(feature) 내용."""
    if not in_merge():
        return {"in_merge": False, "files": [], "source_branch": None}
    raw = _git("diff", "--name-only", "-z", "--diff-filter=U")
    paths = [p for p in raw.split("\0") if p]
    source = _run("name-rev", "--name-only", "MERGE_HEAD").stdout.strip() or None
    files = []
    for path in paths:
        merged_path = EDIT_DATA_DIR / path
        files.append(
            {
                **_summarize(path, _read_blob(":3", path) or _read_blob(":2", path)),
                "base": _read_blob(":1", path),
                "ours": _read_blob(":2", path),      # develop 쪽
                "theirs": _read_blob(":3", path),    # feature 쪽
                "merged": merged_path.read_text(encoding="utf-8") if merged_path.exists() else None,
            }
        )
    return {"in_merge": True, "source_branch": source, "files": files}


def resolve_conflict(path: str, content: str) -> None:
    """해결된 내용으로 파일을 덮어쓰고 stage."""
    if not in_merge():
        raise GitError("진행 중인 머지가 없습니다.")
    target = (EDIT_DATA_DIR / path).resolve()
    if not target.is_relative_to(EDIT_DATA_DIR.resolve()):
        raise GitError(f"허용되지 않는 경로입니다: {path!r}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    _git("add", "--", path)


def merge_continue() -> dict[str, Any]:
    if not in_merge():
        raise GitError("진행 중인 머지가 없습니다.")
    remaining = [p for p in _git("diff", "--name-only", "-z", "--diff-filter=U").split("\0") if p]
    if remaining:
        raise GitError(f"아직 해결되지 않은 충돌이 있습니다: {', '.join(remaining)}")
    _git("commit", "--no-edit")
    return {"status": "merged", "pushed": _push_best_effort(EDIT_BASE_BRANCH)}


def merge_abort() -> None:
    if not in_merge():
        raise GitError("진행 중인 머지가 없습니다.")
    _git("merge", "--abort")


# ---------------------------------------------------------------------------
# master vs develop — 운영 미반영 목록
# ---------------------------------------------------------------------------
def pending_for_prod() -> dict[str, Any]:
    """develop에는 있지만 master(운영)에 아직 반영되지 않은 변경 목록."""
    changed = _diff_names(f"{PROD_BRANCH}...{EDIT_BASE_BRANCH}")
    files = []
    for path, change in sorted(changed.items()):
        content = _read_blob(EDIT_BASE_BRANCH, path)
        if content is None:  # develop에서 삭제된 파일은 master 기준으로 요약
            content = _read_blob(PROD_BRANCH, path)
        entry = _summarize(path, content)
        entry["change"] = change
        files.append(entry)
    return {"prod_branch": PROD_BRANCH, "base_branch": EDIT_BASE_BRANCH, "files": files}
