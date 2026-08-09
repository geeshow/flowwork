"""API 카탈로그 — Postman Collection v2.1 + Bruno(.bru) 인덱싱.

카탈로그는 배포 단위로 고정되므로 서버 기동 시 1회 로드해 메모리에 평탄화한다
(부서 디렉토리 → collection 파일 → 폴더 트리 → 개별 요청). 두 형식을 동시에 지원하며
Bruno는 app/bruno.py가 Postman과 동일한 내부 requestTemplate 형태로 정규화한다.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from . import bruno
from .config import CATALOG_DIR
from .models import CatalogEntry

_TEMPLATE_VAR = re.compile(r"\{\{(\w+)\}\}")

# 인메모리 인덱스 (startup 시 build_index로 채움)
_index: list[CatalogEntry] = []
_commit_sha: str | None = None
_environments: dict[str, str] = {}


def extract_template_variables(request_template: dict[str, Any]) -> list[str]:
    """Postman 요청 템플릿에서 {{variable}} 목록 추출 (중복 제거, 순서 보존)."""
    raw = json.dumps(request_template, ensure_ascii=False)
    seen: dict[str, None] = {}
    for m in _TEMPLATE_VAR.finditer(raw):
        seen.setdefault(m.group(1), None)
    return list(seen.keys())


def _request_url(request: dict[str, Any]) -> str:
    url = request.get("url")
    if isinstance(url, str):
        return url
    if isinstance(url, dict):
        return url.get("raw", "")
    return ""


def _entry_id(department: str, collection_file: str, item_path: list[str], name: str) -> str:
    key = "/".join([department, collection_file, *item_path, name])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def _walk_items(
    items: list[dict[str, Any]],
    *,
    department: str,
    collection_file: str,
    trail: list[str],
    out: list[CatalogEntry],
) -> None:
    """Postman item 트리를 재귀 순회. 폴더는 하위 item[]을, 요청은 request를 가진다."""
    for item in items:
        name = item.get("name", "")
        if isinstance(item.get("item"), list):  # 폴더
            _walk_items(
                item["item"],
                department=department,
                collection_file=collection_file,
                trail=[*trail, name],
                out=out,
            )
            continue
        request = item.get("request")
        if not isinstance(request, dict):
            continue
        raw_output = item.get("_output")
        output_fields = [str(f) for f in raw_output] if isinstance(raw_output, list) else []
        out.append(
            CatalogEntry(
                id=_entry_id(department, collection_file, trail, name),
                department=department,
                collectionFile=collection_file,
                itemPath=list(trail),
                name=name,
                method=request.get("method", "GET"),
                url=_request_url(request),
                variables=extract_template_variables(request),
                outputFields=output_fields,
                requestTemplate=request,
            )
        )


def build_index(catalog_dir: Path = CATALOG_DIR) -> tuple[list[CatalogEntry], str | None]:
    """카탈로그 디렉토리를 스캔해 (엔트리 목록, commit_sha) 반환.

    Postman(*.postman_collection.json)과 Bruno(bruno.json 컬렉션)를 모두 인덱싱한다.
    """
    entries: list[CatalogEntry] = []
    # Postman 컬렉션
    for path in sorted(catalog_dir.glob("**/*.postman_collection.json")):
        try:
            collection = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        # 부서 = catalog_dir 바로 아래 디렉토리명
        rel = path.relative_to(catalog_dir)
        department = rel.parts[0] if len(rel.parts) > 1 else "_root"
        _walk_items(
            collection.get("item", []),
            department=department,
            collection_file=path.name,
            trail=[],
            out=entries,
        )
    # Bruno 컬렉션 (부서 디렉토리에 bruno.json이 있으면 그 디렉토리의 .bru를 인덱싱)
    for bruno_json in sorted(catalog_dir.glob("*/bruno.json")):
        collection_dir = bruno_json.parent
        department = collection_dir.relative_to(catalog_dir).parts[0]
        entries.extend(
            bruno.build_collection_entries(
                collection_dir,
                department,
                _entry_id,
                CatalogEntry,
                extract_template_variables,
            )
        )
    sha_path = catalog_dir / ".commit_sha"
    commit_sha = sha_path.read_text(encoding="utf-8").strip() if sha_path.exists() else None
    return entries, commit_sha


def build_environments(catalog_dir: Path = CATALOG_DIR) -> dict[str, str]:
    """environments/*.postman_environment.json을 병합해 key→value 맵 생성.

    vault:// 참조는 치환하지 않고 그대로 둔다(프론트로 전달됨). 참조 문자열
    자체는 시크릿이 아니며, 실제 시크릿 치환은 프록시가 호출 직전에 수행한다.
    """
    merged: dict[str, str] = {}
    env_dir = catalog_dir / "environments"
    # Postman 환경
    for path in sorted(env_dir.glob("*.postman_environment.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for v in data.get("values", []):
            if v.get("enabled", True) and "key" in v:
                merged[v["key"]] = v.get("value", "")
    # Bruno 환경 (environments/*.bru)
    for path in sorted(env_dir.glob("*.bru")):
        try:
            merged.update(bruno.parse_environment(path.read_text(encoding="utf-8")))
        except OSError:
            continue
    return merged


def load_index() -> None:
    global _index, _commit_sha, _environments
    _index, _commit_sha = build_index()
    _environments = build_environments()


def environments() -> dict[str, str]:
    return _environments


def search(q: str = "", limit: int = 50) -> tuple[list[CatalogEntry], str | None]:
    if not q:
        return _index[:limit], _commit_sha
    needle = q.lower()
    hits = [
        e
        for e in _index
        if needle in e.name.lower()
        or needle in e.url.lower()
        or any(needle in p.lower() for p in e.itemPath)
    ]
    return hits[:limit], _commit_sha


def get_entry(entry_id: str) -> CatalogEntry | None:
    return next((e for e in _index if e.id == entry_id), None)
