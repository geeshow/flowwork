"""API 요청/응답 스키마.

서버는 워크플로우 JSON의 "구조" 유효성만 검증하고, 스텝 순서·분기·값 리졸브
같은 "의미"는 다루지 않는다 (실행 로직은 프론트 담당).
"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# 프록시
# ---------------------------------------------------------------------------
class ProxyRequest(BaseModel):
    execution_id: str
    step_id: str
    workflow_id: str | None = None
    method: str
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    body: Any | None = None


class ProxyResponse(BaseModel):
    step_id: str
    request: dict[str, Any]
    response: dict[str, Any]
    elapsed_ms: int
    timestamp: float


# ---------------------------------------------------------------------------
# 워크플로우 (구조 검증용 — 느슨하게)
# ---------------------------------------------------------------------------
class WorkflowStep(BaseModel):
    id: str
    order: int
    name: str
    inputs: list[dict[str, Any]] = Field(default_factory=list)
    apiBinding: dict[str, Any] | None = None
    branchCondition: dict[str, Any] | None = None
    stopOnFailure: bool = False


class WorkflowFile(BaseModel):
    id: str
    group: str
    name: str
    description: str | None = None
    steps: list[WorkflowStep] = Field(default_factory=list)


class WorkflowSummary(BaseModel):
    id: str
    group: str
    name: str
    description: str | None = None


# ---------------------------------------------------------------------------
# 카탈로그
# ---------------------------------------------------------------------------
class CatalogEntry(BaseModel):
    id: str
    department: str
    collectionFile: str
    itemPath: list[str]
    name: str
    method: str
    url: str
    variables: list[str] = Field(default_factory=list)
    requestTemplate: dict[str, Any]


class CatalogSearchResult(BaseModel):
    results: list[CatalogEntry]
    catalog_version: str | None = None


# ---------------------------------------------------------------------------
# 실행 이력
# ---------------------------------------------------------------------------
class ExecutionDetail(BaseModel):
    execution_id: str
    steps: list[dict[str, Any]]


class SaveResult(BaseModel):
    status: Literal["saved", "deleted"]
