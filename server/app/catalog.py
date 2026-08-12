"""워크플로우용 API 인덱스 — API 콜렉션(data/api-collections)을 평탄화해 검색/조회.

워크플로우 스텝은 API 콜렉션에 등록된 API만 참조할 수 있다. 콜렉션은 UI에서
수시로 편집되므로 기동 시 1회 로드가 아니라 **호출 시마다 파일을 스캔**한다
(소규모 전제 — 규모가 커지면 저장 시점 인덱스 갱신으로 대체).

CatalogEntry 참조 체계:
  department     = workspace 이름
  collectionFile = 콜렉션 id (이름 변경에도 참조가 깨지지 않도록 id 사용)
  itemPath       = 콜렉션 내 폴더 경로
  name           = 요청 이름
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from . import collections as store
from .models import CatalogEntry

_TEMPLATE_VAR = re.compile(r"\{\{(\w+)\}\}")


def extract_template_variables(request_template: dict[str, Any]) -> list[str]:
    """요청 템플릿에서 {{variable}} 목록 추출 (중복 제거, 순서 보존)."""
    raw = json.dumps(request_template, ensure_ascii=False)
    seen: dict[str, None] = {}
    for m in _TEMPLATE_VAR.finditer(raw):
        seen.setdefault(m.group(1), None)
    return list(seen.keys())


def entry_id(department: str, collection_file: str, item_path: list[str], name: str) -> str:
    key = "/".join([department, collection_file, *item_path, name])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def apic_request_to_template(request: dict[str, Any]) -> dict[str, Any]:
    """API 콜렉션 요청 → 실행 엔진이 소비하는 Postman형 템플릿.

    - 활성(enabled) query 파라미터는 url에 병합 (엔진은 url 문자열만 치환)
    - 활성 헤더만 포함, body는 raw 문자열로 (엔진이 치환 후 JSON 파싱 시도)
    """
    url = str(request.get("url") or "")
    query = [
        p
        for p in request.get("params") or []
        if isinstance(p, dict)
        and p.get("kind", "query") == "query"
        and p.get("enabled", True)
        and p.get("name")
    ]
    if query:
        qs = "&".join(f"{p['name']}={p.get('value', '')}" for p in query)
        url = f"{url}{'&' if '?' in url else '?'}{qs}"

    header = [
        {"key": h.get("name", ""), "value": h.get("value", "")}
        for h in request.get("headers") or []
        if isinstance(h, dict) and h.get("enabled", True) and h.get("name")
    ]
    template: dict[str, Any] = {
        "method": str(request.get("method") or "GET"),
        "header": header,
        "url": {"raw": url},
    }
    body = request.get("body") or {}
    raw = None
    if body.get("mode") == "json":
        raw = body.get("json")
    elif body.get("mode") == "text":
        raw = body.get("text")
    if raw:
        template["body"] = {"mode": "raw", "raw": raw}
    return template


def _output_meta(raw: Any) -> tuple[list[str], dict[str, str]]:
    """request.output(문자열 또는 {name, label} 혼합) → (필드명 목록, 필드명→라벨 맵)."""
    names: list[str] = []
    labels: dict[str, str] = {}
    if not isinstance(raw, list):
        return names, labels
    for f in raw:
        if isinstance(f, dict) and f.get("name"):
            names.append(str(f["name"]))
            if f.get("label"):
                labels[str(f["name"])] = str(f["label"])
        elif isinstance(f, str) and f:
            names.append(f)
    return names, labels


def _walk_items(
    items: list[Any],
    *,
    workspace: str,
    collection_id: str,
    collection_name: str,
    trail: list[str],
    out: list[CatalogEntry],
) -> None:
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "folder":
            _walk_items(
                item.get("items") or [],
                workspace=workspace,
                collection_id=collection_id,
                collection_name=collection_name,
                trail=[*trail, str(item.get("name") or "")],
                out=out,
            )
            continue
        if item.get("type") != "http":
            continue
        request = item.get("request") or {}
        name = str(item.get("name") or "")
        if not name:
            continue
        template = apic_request_to_template(request)
        output_fields, output_labels = _output_meta(request.get("output"))
        out.append(
            CatalogEntry(
                id=entry_id(workspace, collection_id, trail, name),
                department=workspace,
                collectionFile=collection_id,
                collectionName=collection_name,
                itemPath=list(trail),
                name=name,
                method=template["method"],
                url=template["url"]["raw"],
                variables=extract_template_variables(template),
                outputFields=output_fields,
                outputLabels=output_labels,
                requestTemplate=template,
            )
        )


def build_entries(source: str = "prod", branch: str | None = None) -> list[CatalogEntry]:
    """모든 workspace의 모든 콜렉션을 평탄화한 엔트리 목록.

    source=edit(+branch)이면 편집 worktree의 콜렉션 기준 — 편집 메뉴의 워크플로우
    편집/실행이 브랜치에서 수정 중인 API를 그대로 쓸 수 있다.
    """
    entries: list[CatalogEntry] = []
    for ws in store.list_workspaces(source, branch):
        for summary in store.list_collections(ws["name"], source, branch):
            doc = store.load_collection(ws["name"], summary["id"], source, branch)
            if doc is None:
                continue
            _walk_items(
                doc.get("items") or [],
                workspace=ws["name"],
                collection_id=doc.get("id", summary["id"]),
                collection_name=str(doc.get("name") or summary.get("name") or ""),
                trail=[],
                out=entries,
            )
    return entries


def environments(source: str = "prod", branch: str | None = None) -> dict[str, str]:
    """모든 콜렉션의 모든 환경을 병합한 key→value 맵.

    (구 카탈로그의 environments/ 병합과 동일한 의미 — 콜렉션 간 공용 변수
    참조를 허용한다. vault:// 참조는 그대로 두고 프록시가 호출 직전 치환.)
    """
    merged: dict[str, str] = {}
    for ws in store.list_workspaces(source, branch):
        for summary in store.list_collections(ws["name"], source, branch):
            doc = store.load_collection(ws["name"], summary["id"], source, branch)
            if doc is None:
                continue
            for env in doc.get("environments") or []:
                for v in env.get("variables") or []:
                    if isinstance(v, dict) and v.get("enabled", True) and v.get("name"):
                        merged[str(v["name"])] = str(v.get("value") or "")
    return merged


def search(
    q: str = "", limit: int = 50, source: str = "prod", branch: str | None = None
) -> tuple[list[CatalogEntry], str | None]:
    entries = build_entries(source, branch)
    if not q:
        return entries[:limit], None
    needle = q.lower()
    hits = [
        e
        for e in entries
        if needle in e.name.lower()
        or needle in e.url.lower()
        or needle in e.department.lower()
        or any(needle in p.lower() for p in e.itemPath)
    ]
    return hits[:limit], None


def get_entry(entry_id_: str, source: str = "prod", branch: str | None = None) -> CatalogEntry | None:
    return next((e for e in build_entries(source, branch) if e.id == entry_id_), None)
