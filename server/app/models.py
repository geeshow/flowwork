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
    # execution_id가 없으면(콤보/의존조회 같은 UI 보조 호출) 이력에 남기지 않는다.
    execution_id: str | None = None
    step_id: str | None = None
    workflow_id: str | None = None
    method: str
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    body: Any | None = None


class ProxyResponse(BaseModel):
    step_id: str | None = None
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
    # 처리 단계: API 호출(apiBinding) 또는 다른 업무 연결(workflowBinding) 중 하나
    apiBinding: dict[str, Any] | None = None
    workflowBinding: dict[str, Any] | None = None
    branchCondition: dict[str, Any] | None = None
    stopOnFailure: bool = False
    resultView: dict[str, Any] | None = None  # 결과 표시(원본/표 + 컬럼)
    midInputs: list[dict[str, Any]] | None = None  # 중간 입력(다음 스텝 전 추가 입력)


class WorkflowFile(BaseModel):
    id: str
    domain: str
    task: str
    name: str
    description: str | None = None
    baseInputs: list[dict[str, Any]] = Field(default_factory=list)  # 기본 입력값
    steps: list[WorkflowStep] = Field(default_factory=list)


class WorkflowSummary(BaseModel):
    id: str
    domain: str
    task: str
    name: str
    description: str | None = None


class DomainColor(BaseModel):
    color: str  # 팔레트 id (storage.ALLOWED_PALETTE_IDS로 검증)


# ---------------------------------------------------------------------------
# 워크플로우용 API 인덱스 (API 콜렉션 평탄화)
# ---------------------------------------------------------------------------
class CatalogEntry(BaseModel):
    id: str
    department: str  # workspace 이름
    collectionFile: str  # 콜렉션 id
    collectionName: str = ""  # 콜렉션 표시 이름 (편집기 필터용)
    itemPath: list[str]
    name: str
    method: str
    url: str
    variables: list[str] = Field(default_factory=list)
    outputFields: list[str] = Field(default_factory=list)  # API 명세서상 응답(output) 필드명
    outputLabels: dict[str, str] = Field(default_factory=dict)  # 필드명 → 한글 설명(라벨)
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
