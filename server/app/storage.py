"""파일 기반 저장소 — 워크플로우 CRUD, 실행 이력 append/조회.

- 워크플로우: `data/workflows/{group}/{workflow_id}.json`, tmp→replace 원자적 저장
- 실행 이력: `data/executions/{execution_id}.jsonl`, append-only (동시 쓰기 락 불필요)
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

import aiofiles

from .config import DATA_DIR, EXECUTIONS_DIR, edit_worktree_path
from .models import WorkflowFile, WorkflowSummary

# 데이터 소스: "prod"(운영 트리 = master 체크아웃) | "edit"(브랜치별 편집 worktree).
# edit 소스는 branch로 worktree를 고른다 (미지정 시 develop).
# 실행 이력은 소스와 무관하게 운영 트리의 executions/에만 쌓인다.
Source = str


def data_root(source: Source = "prod", branch: str | None = None) -> Path:
    if source == "edit":
        if (DATA_DIR / ".git").exists():
            # git 저장소면 브랜치 worktree를 보장한다 (없으면 생성)
            from . import gitops

            try:
                return gitops.ensure_worktree(branch)
            except gitops.GitError as e:
                raise ValueError(str(e)) from e
        # 비-git 환경(테스트 등): 같은 경로 규칙의 일반 디렉토리 사용
        return edit_worktree_path(branch)
    if source == "prod":
        return DATA_DIR
    raise ValueError(f"알 수 없는 데이터 소스입니다: {source!r}")


def _workflows_dir(source: Source, branch: str | None = None) -> Path:
    return data_root(source, branch) / "workflows"


def _domains_file(source: Source, branch: str | None = None) -> Path:
    return data_root(source, branch) / "domains.json"

# 도메인 색상은 임의의 hex 색상을 허용한다 (#rgb 또는 #rrggbb).
_HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

# 경로 traversal 방지: 단어문자(유니코드 — 한글 포함) + 하이픈만 허용.
# '/', '\\', '.', 공백 등이 배제되므로 '..' 같은 traversal이 불가능하다.
_SAFE_SEGMENT = re.compile(r"^[-\w]+$", re.UNICODE)


def _safe(segment: str) -> str:
    if not segment or not _SAFE_SEGMENT.match(segment):
        raise ValueError(f"허용되지 않는 이름입니다: {segment!r}")
    return segment


# ---------------------------------------------------------------------------
# 실행 이력
# ---------------------------------------------------------------------------
async def append_execution_log(execution_id: str, entry: dict[str, Any]) -> None:
    path = EXECUTIONS_DIR / f"{_safe(execution_id)}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(path, mode="a", encoding="utf-8") as f:
        await f.write(json.dumps(entry, ensure_ascii=False) + "\n")


async def read_execution_log(execution_id: str) -> list[dict[str, Any]] | None:
    path = EXECUTIONS_DIR / f"{_safe(execution_id)}.jsonl"
    if not path.exists():
        return None
    async with aiofiles.open(path, encoding="utf-8") as f:
        lines = await f.readlines()
    return [json.loads(line) for line in lines if line.strip()]


def list_executions() -> list[dict[str, Any]]:
    """실행 이력 목록 (실행 시각/전체 상태 요약). 큰 규모라면 인덱스 파일로 대체."""
    if not EXECUTIONS_DIR.exists():
        return []
    out: list[dict[str, Any]] = []
    for path in EXECUTIONS_DIR.glob("*.jsonl"):
        try:
            lines = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
        except (json.JSONDecodeError, OSError):
            continue
        # 스텝 로그만 상태/개수 집계에 사용 (입력값 등 메타 엔트리는 제외)
        step_lines = [l for l in lines if l.get("step_id")]
        if not step_lines:
            continue
        statuses = [s.get("response", {}).get("status") for s in step_lines]
        overall = "SUCCESS" if all(s and 200 <= s < 300 for s in statuses) else "FAILED"
        # 워크플로우 귀속: 입력값 엔트리에 최상위 워크플로우 id가 기록돼 있으면 그것을 쓴다
        # (다른 업무 연결 스텝이 첫 스텝이면 step_lines[0]은 하위 워크플로우 id이므로).
        inputs_line = next((l for l in lines if l.get("kind") == "inputs"), None)
        top_wf = (inputs_line and inputs_line.get("workflow_id")) or step_lines[0].get("workflow_id")
        out.append(
            {
                "execution_id": path.stem,
                "step_count": len(step_lines),
                "overall_status": overall,
                "started_at": step_lines[0].get("timestamp"),
                "workflow_id": top_wf,
            }
        )
    out.sort(key=lambda e: e.get("started_at") or 0, reverse=True)
    return out


# ---------------------------------------------------------------------------
# 워크플로우 CRUD — 저장 경로: data/workflows/{domain}/{task}/{id}.json
#   id는 내부 식별자(불변). 도메인/업무가 바뀌면 파일을 이동한다.
# ---------------------------------------------------------------------------
class DuplicateNameError(Exception):
    """같은 (도메인, 업무) 내에서 이름이 중복될 때."""


class VersionConflictError(Exception):
    """낙관적 잠금 충돌 — 조회 이후 다른 사용자가 같은 워크플로우를 저장/삭제함."""

    def __init__(self, message: str, current_version: str | None):
        super().__init__(message)
        self.current_version = current_version


def _file_version(path: Path) -> str:
    """파일 내용 해시 — 낙관적 잠금 버전으로 사용."""
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def _workflow_path(domain: str, task: str, workflow_id: str, source: Source = "prod", branch: str | None = None) -> Path:
    return _workflows_dir(source, branch) / _safe(domain) / _safe(task) / f"{_safe(workflow_id)}.json"


def _find_path_by_id(workflow_id: str, source: Source = "prod", branch: str | None = None) -> Path | None:
    """id(=파일명)로 기존 파일 경로를 찾는다 (도메인/업무 무관)."""
    root = _workflows_dir(source, branch)
    if not root.exists():
        return None
    return next(root.glob(f"*/*/{_safe(workflow_id)}.json"), None)


def _name_conflict(domain: str, task: str, name: str, self_id: str, source: Source = "prod", branch: str | None = None) -> bool:
    """같은 (도메인, 업무)에 동일 name을 가진 다른 워크플로우가 있는지."""
    folder = _workflows_dir(source, branch) / _safe(domain) / _safe(task)
    if not folder.exists():
        return False
    for path in folder.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if data.get("name") == name and data.get("id") != self_id:
            return True
    return False


async def save_workflow(
    wf: WorkflowFile, source: Source = "prod", branch: str | None = None, force: bool = False
) -> str:
    """저장 후 새 버전을 반환한다.

    wf.version(조회 시점 버전)이 있으면 낙관적 잠금을 검사한다 — 그 사이 다른
    사용자가 저장/삭제했으면 VersionConflictError. force=True면 검사 생략(덮어쓰기).
    """
    if _name_conflict(wf.domain, wf.task, wf.name, wf.id, source, branch):
        raise DuplicateNameError(f"'{wf.domain}/{wf.task}'에 이미 '{wf.name}' 이름이 있습니다.")

    new_path = _workflow_path(wf.domain, wf.task, wf.id, source, branch)
    old_path = _find_path_by_id(wf.id, source, branch)

    if not force and wf.version is not None:
        if old_path is None:
            raise VersionConflictError("다른 사용자가 이 워크플로우를 삭제했습니다.", None)
        current = _file_version(old_path)
        if current != wf.version:
            raise VersionConflictError("다른 사용자가 이 워크플로우를 먼저 저장했습니다.", current)

    new_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = new_path.with_suffix(".json.tmp")
    async with aiofiles.open(tmp_path, "w", encoding="utf-8") as f:
        # version은 낙관적 잠금용 메타라 파일에는 저장하지 않는다
        await f.write(wf.model_dump_json(indent=2, exclude={"version"}))
    tmp_path.replace(new_path)  # 원자적 교체

    # 도메인/업무가 바뀌어 경로가 달라졌으면 기존 파일 제거 (이동)
    if old_path is not None and old_path.resolve() != new_path.resolve():
        old_path.unlink(missing_ok=True)
    return _file_version(new_path)


async def load_workflow(workflow_id: str, source: Source = "prod", branch: str | None = None) -> WorkflowFile | None:
    path = _find_path_by_id(workflow_id, source, branch)
    if path is None:
        return None
    async with aiofiles.open(path, encoding="utf-8") as f:
        raw = await f.read()
    wf = WorkflowFile.model_validate_json(raw)
    wf.version = _file_version(path)  # 낙관적 잠금 기준 버전
    return wf


async def delete_workflow(workflow_id: str, source: Source = "prod", branch: str | None = None) -> bool:
    path = _find_path_by_id(workflow_id, source, branch)
    if path is None:
        return False
    path.unlink()
    return True


# ---------------------------------------------------------------------------
# 도메인 색상 — data/domains.json에 { "<도메인>": "<팔레트 id>" } 로 저장
# ---------------------------------------------------------------------------
def load_domain_colors(source: Source = "prod", branch: str | None = None) -> dict[str, str]:
    domains_file = _domains_file(source, branch)
    if not domains_file.exists():
        return {}
    try:
        data = json.loads(domains_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if _HEX_COLOR.match(str(v))}


def set_domain_color(domain: str, color: str, source: Source = "prod", branch: str | None = None) -> dict[str, str]:
    _safe(domain)  # 도메인명 검증 (traversal/이상문자 차단)
    if not _HEX_COLOR.match(color):
        raise ValueError(f"허용되지 않는 색상입니다(#rgb/#rrggbb): {color!r}")
    domains_file = _domains_file(source, branch)
    colors = load_domain_colors(source, branch)
    colors[domain] = color
    domains_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = domains_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(colors, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(domains_file)
    return colors


def list_workflows(source: Source = "prod", branch: str | None = None) -> list[WorkflowSummary]:
    root = _workflows_dir(source, branch)
    if not root.exists():
        return []
    out: list[WorkflowSummary] = []
    for path in sorted(root.glob("*/*/*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append(
            WorkflowSummary(
                id=data.get("id", path.stem),
                domain=data.get("domain", path.parent.parent.name),
                task=data.get("task", path.parent.name),
                name=data.get("name", path.stem),
                description=data.get("description"),
            )
        )
    return out
