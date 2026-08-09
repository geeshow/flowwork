"""파일 기반 저장소 — 워크플로우 CRUD, 실행 이력 append/조회.

- 워크플로우: `data/workflows/{group}/{workflow_id}.json`, tmp→replace 원자적 저장
- 실행 이력: `data/executions/{execution_id}.jsonl`, append-only (동시 쓰기 락 불필요)
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import aiofiles

from .config import EXECUTIONS_DIR, WORKFLOWS_DIR
from .models import WorkflowFile, WorkflowSummary

# 경로 traversal 방지: group/id는 단순 세그먼트만 허용
_SAFE_SEGMENT = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")


def _safe(segment: str) -> str:
    if not segment or not set(segment) <= _SAFE_SEGMENT:
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
# 워크플로우 CRUD
# ---------------------------------------------------------------------------
def _workflow_path(group: str, workflow_id: str) -> Path:
    return WORKFLOWS_DIR / _safe(group) / f"{_safe(workflow_id)}.json"


async def save_workflow(group: str, workflow_id: str, wf: WorkflowFile) -> None:
    path = _workflow_path(group, workflow_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".json.tmp")
    async with aiofiles.open(tmp_path, "w", encoding="utf-8") as f:
        await f.write(wf.model_dump_json(indent=2))
    tmp_path.replace(path)  # 원자적 교체


async def load_workflow(group: str, workflow_id: str) -> WorkflowFile | None:
    path = _workflow_path(group, workflow_id)
    if not path.exists():
        return None
    async with aiofiles.open(path, encoding="utf-8") as f:
        raw = await f.read()
    return WorkflowFile.model_validate_json(raw)


async def delete_workflow(group: str, workflow_id: str) -> bool:
    path = _workflow_path(group, workflow_id)
    if not path.exists():
        return False
    path.unlink()
    return True


def list_workflows() -> list[WorkflowSummary]:
    if not WORKFLOWS_DIR.exists():
        return []
    out: list[WorkflowSummary] = []
    for path in sorted(WORKFLOWS_DIR.glob("*/*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append(
            WorkflowSummary(
                id=data.get("id", path.stem),
                group=data.get("group", path.parent.name),
                name=data.get("name", path.stem),
                description=data.get("description"),
            )
        )
    return out
