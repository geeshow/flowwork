"""로그 리댁션.

실행 이력(JSONL)은 request/response 전체를 기록하고 URL로 공유되므로, 시크릿이
로그에 남으면 공유 링크를 통해 그대로 유출된다.

- 요청 헤더: 고정 키 목록(Authorization 등) 마스킹
- 요청/응답 body: 민감해 보이는 필드명(token/password/secret 등)을 재귀 마스킹

응답 body 리댁션은 **이력에 저장되는 사본에만** 적용한다. 프론트로 반환되는
실시간 응답은 전체를 유지해야 PREV_RESPONSE 체이닝이 동작한다.
"""
from __future__ import annotations

from typing import Any

REDACT_HEADER_KEYS = {"authorization", "x-api-key", "cookie"}
REDACTED = "***REDACTED***"

# 필드명이 이 조각을 (구분자 제거 후) 포함하면 값 마스킹. 로그에만 적용하므로
# 과도 마스킹은 안전한 방향의 오차로 허용한다.
_SENSITIVE_FIELD_PARTS = {
    "password",
    "token",
    "secret",
    "apikey",
    "accesstoken",
    "refreshtoken",
    "authorization",
    "credential",
    "privatekey",
    "clientsecret",
}


def _is_sensitive_field(key: str) -> bool:
    norm = key.lower().replace("-", "").replace("_", "")
    return any(part in norm for part in _SENSITIVE_FIELD_PARTS)


def redact_body(obj: Any) -> Any:
    """dict/list를 재귀 순회하며 민감 필드명의 값을 마스킹한 새 구조를 반환."""
    if isinstance(obj, dict):
        return {
            k: (REDACTED if _is_sensitive_field(k) else redact_body(v))
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [redact_body(v) for v in obj]
    return obj


def redact_for_logging(request: dict[str, Any]) -> dict[str, Any]:
    """request dict를 얕게 복사한 뒤 민감 헤더 값과 body 필드를 마스킹."""
    redacted = {**request}
    headers = redacted.get("headers")
    if isinstance(headers, dict):
        redacted["headers"] = {
            k: (REDACTED if k.lower() in REDACT_HEADER_KEYS else v)
            for k, v in headers.items()
        }
    if "body" in redacted:
        redacted["body"] = redact_body(redacted["body"])
    return redacted


def redact_response(response: dict[str, Any]) -> dict[str, Any]:
    """응답 dict({status, body})의 body를 재귀 마스킹한 사본 반환 (이력 저장용)."""
    return {**response, "body": redact_body(response.get("body"))}
