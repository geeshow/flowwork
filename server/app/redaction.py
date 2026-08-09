"""로그 리댁션.

실행 이력(JSONL)은 request 전체를 기록하고 URL로 공유되므로, 시크릿이 로그에
남으면 공유 링크를 통해 그대로 유출된다. 헤더 리댁션은 POC 단계에서도 유지한다.
"""
from __future__ import annotations

from typing import Any

REDACT_HEADER_KEYS = {"authorization", "x-api-key", "cookie"}
REDACTED = "***REDACTED***"


def redact_for_logging(request: dict[str, Any]) -> dict[str, Any]:
    """request dict를 얕게 복사한 뒤 민감 헤더 값만 마스킹."""
    redacted = {**request}
    headers = redacted.get("headers")
    if isinstance(headers, dict):
        redacted["headers"] = {
            k: (REDACTED if k.lower() in REDACT_HEADER_KEYS else v)
            for k, v in headers.items()
        }
    return redacted
