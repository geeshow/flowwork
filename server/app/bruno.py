"""Bruno(.bru) 파서 — Bruno 컬렉션/환경을 Postman과 동일한 내부 모델로 정규화한다.

프론트엔드는 requestTemplate을 Postman request 형태({method, header[], url.raw, body})로
소비하므로, .bru를 파싱해 그 형태의 dict로 변환한다(프론트 변경 없음). Postman과 Bruno를
동시에 지원하기 위한 모듈이다.

지원 블록: meta / <method> / headers / query / body:* / docs
 - docs 블록의 `output:` 줄에서 응답(output) 필드를 읽는다(Postman의 _output 대응).
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Callable

_HTTP_METHODS = {"get", "post", "put", "delete", "patch", "head", "options"}
_HEADER_RE = re.compile(r"([A-Za-z][\w:]*)\s*\{")


def _split_blocks(text: str) -> list[tuple[str, str]]:
    """최상위 `header { ... }` 블록들을 (header, inner) 목록으로. 중괄호 균형 매칭."""
    blocks: list[tuple[str, str]] = []
    pos = 0
    while True:
        m = _HEADER_RE.search(text, pos)
        if not m:
            break
        header = m.group(1)
        depth = 0
        i = m.end() - 1  # '{' 위치
        start = i + 1
        while i < len(text):
            c = text[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        blocks.append((header, text[start:i]))
        pos = i + 1
    return blocks


def _dict_lines(inner: str) -> list[tuple[str, str]]:
    """`key: value` 줄들을 (key, value) 목록으로 (순서 보존)."""
    out: list[tuple[str, str]] = []
    for line in inner.splitlines():
        line = line.strip()
        if not line or ":" not in line:
            continue
        k, v = line.split(":", 1)
        out.append((k.strip(), v.strip()))
    return out


def parse_request(text: str) -> dict[str, Any]:
    """.bru 요청 텍스트 → {name, seq, request(Postman형), output}."""
    name = ""
    seq = 0
    method = "GET"
    url = ""
    headers: list[dict[str, str]] = []
    body_raw: str | None = None
    output: list[str] = []

    for header, inner in _split_blocks(text):
        if header == "meta":
            for k, v in _dict_lines(inner):
                if k == "name":
                    name = v
                elif k == "seq" and v.isdigit():
                    seq = int(v)
        elif header in _HTTP_METHODS:
            method = header.upper()
            for k, v in _dict_lines(inner):
                if k == "url":
                    url = v
        elif header == "headers":
            headers = [{"key": k, "value": v} for k, v in _dict_lines(inner)]
        elif header.startswith("body:"):
            body_raw = inner.strip()
        elif header == "docs":
            for k, v in _dict_lines(inner):
                if k == "output":
                    output = [f.strip() for f in v.split(",") if f.strip()]

    request: dict[str, Any] = {"method": method, "header": headers, "url": {"raw": url}}
    if body_raw is not None:
        request["body"] = {"mode": "raw", "raw": body_raw}
    return {"name": name, "seq": seq, "request": request, "output": output}


def parse_environment(text: str) -> dict[str, str]:
    """.bru 환경 텍스트의 vars 블록 → key→value 맵."""
    values: dict[str, str] = {}
    for header, inner in _split_blocks(text):
        if header == "vars" or header.startswith("vars:"):
            for k, v in _dict_lines(inner):
                values[k] = v
    return values


def build_collection_entries(
    collection_dir: Path,
    department: str,
    entry_id: Callable[[str, str, list[str], str], str],
    catalog_entry_cls: type,
    extract_vars: Callable[[dict[str, Any]], list[str]],
) -> list[Any]:
    """Bruno 컬렉션 디렉토리(bruno.json 포함)를 재귀 순회해 CatalogEntry 목록 생성.

    - 폴더(디렉토리) = itemPath, 각 .bru = 요청.
    - collectionFile은 컬렉션 디렉토리명(예: "core")으로 고정.
    - bruno.json / folder.bru(폴더 메타)는 건너뛴다.
    """
    entries: list[Any] = []
    collection_file = collection_dir.name
    for bru in sorted(collection_dir.glob("**/*.bru")):
        if bru.name == "folder.bru":
            continue
        try:
            parsed = parse_request(bru.read_text(encoding="utf-8"))
        except OSError:
            continue
        if not parsed["name"]:
            continue
        trail = list(bru.relative_to(collection_dir).parts[:-1])  # 파일명 제외한 폴더 경로
        request = parsed["request"]
        url = request["url"]["raw"] if isinstance(request["url"], dict) else request["url"]
        entries.append(
            catalog_entry_cls(
                id=entry_id(department, collection_file, trail, parsed["name"]),
                department=department,
                collectionFile=collection_file,
                itemPath=trail,
                name=parsed["name"],
                method=request.get("method", "GET"),
                url=url,
                variables=extract_vars(request),
                outputFields=parsed["output"],
                requestTemplate=request,
            )
        )
    return entries
