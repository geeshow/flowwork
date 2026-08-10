"""Bruno(.bru) 파서 — .bru 요청/환경 텍스트를 dict로 정규화한다.

API 콜렉션의 GitHub/디렉토리 import(app/collections.py)가 사용한다.

지원 블록: meta / <method> / headers / body:* / docs
 - docs 블록의 `output:` 줄에서 응답(output) 필드를 읽는다(Postman의 _output 대응).
"""
from __future__ import annotations

import re
from typing import Any

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
    return [(k, v) for k, v, _ in _dict_lines_annotated(inner)]


# Bruno v2 어노테이션 — key-value 줄 바로 위의 @description('...') / @description("...")
_DESCRIPTION_RE = re.compile(r"""^@description\(\s*(['"])(.*)\1\s*\)$""")


def _dict_lines_annotated(inner: str) -> list[tuple[str, str, str | None]]:
    """`key: value` 줄들을 (key, value, description) 목록으로 (순서 보존)."""
    out: list[tuple[str, str, str | None]] = []
    pending_desc: str | None = None
    for line in inner.splitlines():
        line = line.strip()
        if not line:
            continue
        m = _DESCRIPTION_RE.match(line)
        if m:
            pending_desc = m.group(2)
            continue
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        out.append((k.strip(), v.strip(), pending_desc))
        pending_desc = None
    return out


def parse_request(text: str) -> dict[str, Any]:
    """.bru 요청 텍스트 → {name, seq, request(Postman형), bodyMode, output}.

    output은 docs 블록의 `output:` 줄에서 읽으며 `이름=라벨` 형식으로 한글 설명을
    함께 담을 수 있다 (라벨이 없으면 문자열, 있으면 {name, label}).
    """
    name = ""
    seq = 0
    method = "GET"
    url = ""
    headers: list[dict[str, Any]] = []
    body_raw: str | None = None
    body_mode: str | None = None
    output: list[Any] = []

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
            headers = [
                {"key": k, "value": v, **({"description": d} if d else {})}
                for k, v, d in _dict_lines_annotated(inner)
            ]
        elif header == "body" or header.startswith("body:"):
            body_raw = inner.strip()
            # `body:json` 등 블록 헤더의 모드. 모드 없는 `body` 블록은 Bruno 기본인 json.
            body_mode = header.partition(":")[2] or "json"
        elif header == "docs":
            for k, v in _dict_lines(inner):
                if k == "output":
                    output = []
                    for field in v.split(","):
                        field = field.strip()
                        if not field:
                            continue
                        if "=" in field:  # `이름=라벨` — 한글 설명 포함
                            fname, label = field.split("=", 1)
                            output.append({"name": fname.strip(), "label": label.strip()})
                        else:
                            output.append(field)

    request: dict[str, Any] = {"method": method, "header": headers, "url": {"raw": url}}
    if body_raw is not None:
        request["body"] = {"mode": "raw", "raw": body_raw}
    return {"name": name, "seq": seq, "request": request, "bodyMode": body_mode, "output": output}


def parse_environment(text: str) -> dict[str, str]:
    """.bru 환경 텍스트의 vars 블록 → key→value 맵."""
    values: dict[str, str] = {}
    for header, inner in _split_blocks(text):
        if header == "vars" or header.startswith("vars:"):
            for k, v in _dict_lines(inner):
                values[k] = v
    return values
