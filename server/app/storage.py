"""파일 기반 저장소 — 워크플로우 CRUD, 실행 이력 append/조회.

- 워크플로우: `data/workflows/{group}/{workflow_id}.json`, tmp→replace 원자적 저장
- 실행 이력: `data/executions/{execution_id}.jsonl`, append-only (동시 쓰기 락 불필요)
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import aiofiles

from .config import DOMAINS_FILE, EXECUTIONS_DIR, WORKFLOWS_DIR
from .models import WorkflowFile, WorkflowSummary

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
        if not lines:
            continue
        statuses = [s.get("response", {}).get("status") for s in lines]
        overall = "SUCCESS" if all(s and 200 <= s < 300 for s in statuses) else "FAILED"
        out.append(
            {
                "execution_id": path.stem,
                "step_count": len(lines),
                "overall_status": overall,
                "started_at": lines[0].get("timestamp"),
                "workflow_id": lines[0].get("workflow_id"),
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


def _workflow_path(domain: str, task: str, workflow_id: str) -> Path:
    return WORKFLOWS_DIR / _safe(domain) / _safe(task) / f"{_safe(workflow_id)}.json"


def _find_path_by_id(workflow_id: str) -> Path | None:
    """id(=파일명)로 기존 파일 경로를 찾는다 (도메인/업무 무관)."""
    if not WORKFLOWS_DIR.exists():
        return None
    return next(WORKFLOWS_DIR.glob(f"*/*/{_safe(workflow_id)}.json"), None)


def _name_conflict(domain: str, task: str, name: str, self_id: str) -> bool:
    """같은 (도메인, 업무)에 동일 name을 가진 다른 워크플로우가 있는지."""
    folder = WORKFLOWS_DIR / _safe(domain) / _safe(task)
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


async def save_workflow(wf: WorkflowFile) -> None:
    if _name_conflict(wf.domain, wf.task, wf.name, wf.id):
        raise DuplicateNameError(f"'{wf.domain}/{wf.task}'에 이미 '{wf.name}' 이름이 있습니다.")

    new_path = _workflow_path(wf.domain, wf.task, wf.id)
    old_path = _find_path_by_id(wf.id)

    new_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = new_path.with_suffix(".json.tmp")
    async with aiofiles.open(tmp_path, "w", encoding="utf-8") as f:
        await f.write(wf.model_dump_json(indent=2))
    tmp_path.replace(new_path)  # 원자적 교체

    # 도메인/업무가 바뀌어 경로가 달라졌으면 기존 파일 제거 (이동)
    if old_path is not None and old_path.resolve() != new_path.resolve():
        old_path.unlink(missing_ok=True)


async def load_workflow(workflow_id: str) -> WorkflowFile | None:
    path = _find_path_by_id(workflow_id)
    if path is None:
        return None
    async with aiofiles.open(path, encoding="utf-8") as f:
        raw = await f.read()
    return WorkflowFile.model_validate_json(raw)


async def delete_workflow(workflow_id: str) -> bool:
    path = _find_path_by_id(workflow_id)
    if path is None:
        return False
    path.unlink()
    return True


# ---------------------------------------------------------------------------
# 도메인 색상 — data/domains.json에 { "<도메인>": "<팔레트 id>" } 로 저장
# ---------------------------------------------------------------------------
def load_domain_colors() -> dict[str, str]:
    if not DOMAINS_FILE.exists():
        return {}
    try:
        data = json.loads(DOMAINS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items() if _HEX_COLOR.match(str(v))}


def set_domain_color(domain: str, color: str) -> dict[str, str]:
    _safe(domain)  # 도메인명 검증 (traversal/이상문자 차단)
    if not _HEX_COLOR.match(color):
        raise ValueError(f"허용되지 않는 색상입니다(#rgb/#rrggbb): {color!r}")
    colors = load_domain_colors()
    colors[domain] = color
    DOMAINS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DOMAINS_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(colors, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(DOMAINS_FILE)
    return colors


def list_workflows() -> list[WorkflowSummary]:
    if not WORKFLOWS_DIR.exists():
        return []
    out: list[WorkflowSummary] = []
    for path in sorted(WORKFLOWS_DIR.glob("*/*/*.json")):
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
