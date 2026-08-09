"""flowwork 서버 (FastAPI).

책임을 세 가지로 한정한다:
  1. API 호출 proxy (SSRF allowlist + 시크릿 리졸브 + 로그 리댁션)
  2. 실행 이력 append / 조회
  3. 워크플로우 CRUD (파일 기반) + API 카탈로그 인메모리 인덱싱

실행 로직(값 리졸브, 분기 판단, 스텝 순회)은 프론트가 담당한다.
"""
from __future__ import annotations

import time
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from app import catalog, storage
from app.config import ALLOWED_HOST_PREFIXES, PROXY_TIMEOUT_SECONDS
from app.models import (
    CatalogSearchResult,
    ExecutionDetail,
    ProxyRequest,
    ProxyResponse,
    SaveResult,
    WorkflowFile,
)
from app.redaction import redact_for_logging
from app.secrets import SecretNotFoundError, resolve_vault_deep


@asynccontextmanager
async def lifespan(_: FastAPI):
    catalog.load_index()  # 기동 시 카탈로그 1회 로드
    yield


app = FastAPI(title="flowwork", version="0.1.0", lifespan=lifespan)

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

    log_entry = ProxyResponse(
        step_id=req.step_id,
        request=redact_for_logging(req.model_dump()),
        response={"status": status, "body": resp_body},
        elapsed_ms=int((time.time() - start) * 1000),
        timestamp=time.time(),
    )
    stored = {**log_entry.model_dump(), "workflow_id": req.workflow_id}
    await storage.append_execution_log(req.execution_id, stored)
    return log_entry


# ---------------------------------------------------------------------------
# 2. 실행 이력
# ---------------------------------------------------------------------------
@app.get("/api/executions")
async def list_executions() -> dict:
    return {"executions": storage.list_executions()}


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


@app.get("/api/workflows/{group}/{workflow_id}", response_model=WorkflowFile)
async def get_workflow(group: str, workflow_id: str) -> WorkflowFile:
    try:
        wf = await storage.load_workflow(group, workflow_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if wf is None:
        raise HTTPException(404, "워크플로우를 찾을 수 없습니다")
    return wf


@app.put("/api/workflows/{group}/{workflow_id}", response_model=SaveResult)
async def save_workflow(group: str, workflow_id: str, wf: WorkflowFile) -> SaveResult:
    try:
        await storage.save_workflow(group, workflow_id, wf)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return SaveResult(status="saved")


@app.delete("/api/workflows/{group}/{workflow_id}", response_model=SaveResult)
async def delete_workflow(group: str, workflow_id: str) -> SaveResult:
    try:
        deleted = await storage.delete_workflow(group, workflow_id)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not deleted:
        raise HTTPException(404, "워크플로우를 찾을 수 없습니다")
    return SaveResult(status="deleted")


# ---------------------------------------------------------------------------
# 4. API 카탈로그
# ---------------------------------------------------------------------------
@app.get("/api/catalog/search", response_model=CatalogSearchResult)
async def search_catalog(q: str = "") -> CatalogSearchResult:
    results, version = catalog.search(q)
    return CatalogSearchResult(results=results, catalog_version=version)


@app.get("/api/catalog/environments")
async def get_environments() -> dict:
    # vault:// 참조는 그대로 반환(프록시가 호출 직전 치환)
    return {"values": catalog.environments()}


@app.get("/api/catalog/entry/{entry_id}")
async def get_catalog_entry(entry_id: str) -> dict:
    entry = catalog.get_entry(entry_id)
    if entry is None:
        raise HTTPException(404, "카탈로그 항목을 찾을 수 없습니다")
    return entry.model_dump()


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}
