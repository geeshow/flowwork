"""flowwork 서버 (FastAPI).

책임을 세 가지로 한정한다:
  1. API 호출 proxy (SSRF allowlist + 시크릿 리졸브 + 로그 리댁션)
  2. 실행 이력 append / 조회
  3. 워크플로우 CRUD (파일 기반) + API 카탈로그 인메모리 인덱싱

실행 로직(값 리졸브, 분기 판단, 스텝 순회)은 프론트가 담당한다.
"""
from __future__ import annotations

import time

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import catalog, collections, storage
from app.config import ALLOWED_HOST_PREFIXES, PROXY_TIMEOUT_SECONDS
from app.models import (
    CatalogSearchResult,
    DomainColor,
    ExecutionDetail,
    ProxyRequest,
    ProxyResponse,
    SaveResult,
    WorkflowFile,
)
from app.redaction import redact_body, redact_for_logging, redact_response
from app.secrets import SecretNotFoundError, resolve_vault_deep


app = FastAPI(title="flowwork", version="0.1.0")

# POC: 로컬 개발 프론트(vite)에서의 접근 허용
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _safe_json(resp: httpx.Response):
    try:
        return resp.json()
    except ValueError:
        return {"_raw": resp.text}


# ---------------------------------------------------------------------------
# 1. 프록시
# ---------------------------------------------------------------------------
@app.post("/api/proxy", response_model=ProxyResponse)
async def proxy_call(req: ProxyRequest) -> ProxyResponse:
    if not any(req.url.startswith(p) for p in ALLOWED_HOST_PREFIXES):
        raise HTTPException(403, "허용되지 않은 API 호스트입니다")

    # 시크릿(vault:// 참조)은 실제 호출 직전에만 리졸브한다.
    # 리졸브된 값은 로그(아래 redact_for_logging 대상은 원본 req)에 남지 않는다.
    try:
        out_headers = resolve_vault_deep(req.headers)
        out_body = resolve_vault_deep(req.body)
    except SecretNotFoundError as e:
        raise HTTPException(502, str(e)) from e

    start = time.time()
    status: int | None
    resp_body: object
    async with httpx.AsyncClient(timeout=PROXY_TIMEOUT_SECONDS) as client:
        try:
            resp = await client.request(
                req.method, req.url, headers=out_headers, json=out_body
            )
            status, resp_body = resp.status_code, _safe_json(resp)
        except httpx.RequestError as e:
            status, resp_body = None, {"error": str(e)}

    full_response = {"status": status, "body": resp_body}
    log_entry = ProxyResponse(
        step_id=req.step_id,
        request=redact_for_logging(req.model_dump()),
        response=full_response,  # 프론트로는 전체 응답 반환 (PREV_RESPONSE 체이닝용)
        elapsed_ms=int((time.time() - start) * 1000),
        timestamp=time.time(),
    )
    # execution_id가 있을 때만 이력에 append (콤보/의존조회 보조 호출은 로깅 생략).
    # 이력(JSONL, URL 공유)에는 응답 body도 리댁션한 사본을 저장.
    if req.execution_id:
        stored = {
            **log_entry.model_dump(),
            "response": redact_response(full_response),
            "workflow_id": req.workflow_id,
        }
        await storage.append_execution_log(req.execution_id, stored)
    return log_entry


# ---------------------------------------------------------------------------
# 2. 실행 이력
# ---------------------------------------------------------------------------
@app.get("/api/executions")
async def list_executions() -> dict:
    return {"executions": storage.list_executions()}


class ExecutionInputsBody(BaseModel):
    values: dict[str, object] = {}
    workflow_id: str | None = None


@app.post("/api/executions/{execution_id}/inputs", response_model=SaveResult)
async def record_execution_inputs(execution_id: str, body: ExecutionInputsBody) -> SaveResult:
    """실행에 사용된 입력값을 이력에 기록한다(리댁션 적용 — 비밀번호 등 마스킹)."""
    try:
        await storage.append_execution_log(
            execution_id,
            {
                "kind": "inputs",
                "values": redact_body(body.values),
                "workflow_id": body.workflow_id,
                "timestamp": time.time(),
            },
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return SaveResult(status="saved")


@app.get("/api/executions/{execution_id}", response_model=ExecutionDetail)
async def get_execution(execution_id: str) -> ExecutionDetail:
    try:
        steps = await storage.read_execution_log(execution_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if steps is None:
        raise HTTPException(404, "실행 이력을 찾을 수 없습니다")
    return ExecutionDetail(execution_id=execution_id, steps=steps)


# ---------------------------------------------------------------------------
# 3. 워크플로우 CRUD
# ---------------------------------------------------------------------------
@app.get("/api/workflows")
async def list_workflows() -> dict:
    return {"workflows": [w.model_dump() for w in storage.list_workflows()]}


@app.get("/api/workflows/{workflow_id}", response_model=WorkflowFile)
async def get_workflow(workflow_id: str) -> WorkflowFile:
    try:
        wf = await storage.load_workflow(workflow_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if wf is None:
        raise HTTPException(404, "워크플로우를 찾을 수 없습니다")
    return wf


@app.put("/api/workflows/{workflow_id}", response_model=SaveResult)
async def save_workflow(workflow_id: str, wf: WorkflowFile) -> SaveResult:
    if wf.id != workflow_id:
        raise HTTPException(400, "경로의 id와 본문의 id가 일치하지 않습니다")
    try:
        await storage.save_workflow(wf)
    except storage.DuplicateNameError as e:
        raise HTTPException(409, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return SaveResult(status="saved")


@app.delete("/api/workflows/{workflow_id}", response_model=SaveResult)
async def delete_workflow(workflow_id: str) -> SaveResult:
    try:
        deleted = await storage.delete_workflow(workflow_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not deleted:
        raise HTTPException(404, "워크플로우를 찾을 수 없습니다")
    return SaveResult(status="deleted")


# ---------------------------------------------------------------------------
# 3-b. 도메인 색상 (팔레트 id 매핑)
# ---------------------------------------------------------------------------
@app.get("/api/domains")
async def list_domain_colors() -> dict:
    return {"colors": storage.load_domain_colors()}


@app.put("/api/domains/{domain}", response_model=SaveResult)
async def set_domain_color(domain: str, body: DomainColor) -> SaveResult:
    try:
        storage.set_domain_color(domain, body.color)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return SaveResult(status="saved")


# ---------------------------------------------------------------------------
# 4. 워크플로우용 API 인덱스 — API 콜렉션(api-collections)을 평탄화해 제공.
#    워크플로우는 API 콜렉션에 등록된 API만 사용할 수 있다.
# ---------------------------------------------------------------------------
@app.get("/api/catalog/search", response_model=CatalogSearchResult)
async def search_catalog(q: str = "") -> CatalogSearchResult:
    results, version = catalog.search(q)
    return CatalogSearchResult(results=results, catalog_version=version)


@app.get("/api/catalog/environments")
async def get_environments() -> dict:
    # 모든 콜렉션의 환경 병합. vault:// 참조는 그대로 반환(프록시가 호출 직전 치환)
    return {"values": catalog.environments()}


@app.get("/api/catalog/entry/{entry_id}")
async def get_catalog_entry(entry_id: str) -> dict:
    entry = catalog.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, "카탈로그 항목을 찾을 수 없습니다")
    return entry.model_dump()


# ---------------------------------------------------------------------------
# 5. API 콜렉션 (Bruno 스타일 workspace/collection + Import/Export)
# ---------------------------------------------------------------------------
class NameBody(BaseModel):
    name: str


@app.get("/api/apic/workspaces")
async def apic_list_workspaces() -> dict:
    return {"workspaces": collections.list_workspaces()}


@app.post("/api/apic/workspaces", response_model=SaveResult)
async def apic_create_workspace(body: NameBody) -> SaveResult:
    try:
        collections.create_workspace(body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return SaveResult(status="saved")


@app.delete("/api/apic/workspaces/{workspace}", response_model=SaveResult)
async def apic_delete_workspace(workspace: str) -> SaveResult:
    try:
        deleted = collections.delete_workspace(workspace)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not deleted:
        raise HTTPException(404, "workspace를 찾을 수 없습니다")
    return SaveResult(status="deleted")


@app.get("/api/apic/workspaces/{workspace}/collections")
async def apic_list_collections(workspace: str) -> dict:
    try:
        return {"collections": collections.list_collections(workspace)}
    except ValueError as e:
        raise HTTPException(404, str(e)) from e


@app.post("/api/apic/workspaces/{workspace}/collections")
async def apic_create_collection(workspace: str, body: NameBody) -> dict:
    try:
        return collections.create_collection(workspace, body.name)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/apic/workspaces/{workspace}/collections/import")
async def apic_import_collection(workspace: str, data: dict) -> dict:
    try:
        return collections.import_collection(workspace, data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class GithubImportBody(BaseModel):
    url: str


@app.get("/api/apic/github/status")
async def apic_github_status() -> dict:
    """GitHub 인증 상태 (gh CLI 또는 GITHUB_TOKEN env). private 레포 import에 사용."""
    return await collections.github_auth_status()


@app.post("/api/apic/workspaces/{workspace}/collections/import-github")
async def apic_import_github(workspace: str, body: GithubImportBody) -> dict:
    """GitHub 레포 URL에서 Bruno/Postman 콜렉션을 찾아 workspace에 추가한다."""
    try:
        return {"imported": await collections.import_from_github(workspace, body.url)}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/apic/workspaces/{workspace}/collections/{collection_id}/sync")
async def apic_sync_collection(workspace: str, collection_id: str) -> dict:
    """GitHub에 연결된 콜렉션을 레포 최신 내용으로 갱신 (id 유지 → 워크플로우 참조 보존)."""
    try:
        return await collections.sync_collection(workspace, collection_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/apic/workspaces/{workspace}/collections/{collection_id}")
async def apic_get_collection(workspace: str, collection_id: str) -> dict:
    try:
        doc = collections.load_collection(workspace, collection_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if doc is None:
        raise HTTPException(404, "콜렉션을 찾을 수 없습니다")
    return doc


@app.put("/api/apic/workspaces/{workspace}/collections/{collection_id}", response_model=SaveResult)
async def apic_save_collection(workspace: str, collection_id: str, doc: dict) -> SaveResult:
    if doc.get("id") != collection_id:
        raise HTTPException(400, "경로의 id와 본문의 id가 일치하지 않습니다")
    try:
        collections.save_collection(workspace, doc)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return SaveResult(status="saved")


@app.delete("/api/apic/workspaces/{workspace}/collections/{collection_id}", response_model=SaveResult)
async def apic_delete_collection(workspace: str, collection_id: str) -> SaveResult:
    try:
        deleted = collections.delete_collection(workspace, collection_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not deleted:
        raise HTTPException(404, "콜렉션을 찾을 수 없습니다")
    return SaveResult(status="deleted")


@app.get("/api/apic/workspaces/{workspace}/collections/{collection_id}/export")
async def apic_export_collection(workspace: str, collection_id: str, format: str = "bruno") -> dict:
    try:
        doc = collections.load_collection(workspace, collection_id)
        if doc is None:
            raise HTTPException(404, "콜렉션을 찾을 수 없습니다")
        return collections.export_collection(doc, format)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
