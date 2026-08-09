"""시크릿 리졸브 (POC: 환경변수 기반).

environment 파일에는 평문 시크릿 대신 `vault://scope/key` 참조만 남긴다.
프록시가 실제 API를 호출하기 직전에만 리졸브하고, 리졸브된 값은 프론트로
반환되는 응답이나 실행 로그에 절대 포함되지 않는다.

운영 전환 시 resolve_secret 구현만 Vault / AWS Secrets Manager로 교체한다.
"""
from __future__ import annotations

import os
import re

VAULT_REF_PATTERN = re.compile(r"^vault://([^/]+)/(.+)$")
# 더 큰 문자열 안에 박힌 참조(예: "Bearer vault://scope/key")를 위한 토큰 패턴
VAULT_TOKEN_PATTERN = re.compile(r"vault://([^/\s]+)/([^\s\"']+)")


class SecretNotFoundError(Exception):
    def __init__(self, env_key: str) -> None:
        super().__init__(f"시크릿을 찾을 수 없습니다: {env_key}")
        self.env_key = env_key


def resolve_secret(scope: str, key: str) -> str:
    """`vault://scope/key` → 환경변수 `SECRET_{SCOPE}_{KEY}` 값."""
    env_key = f"SECRET_{scope.upper()}_{key.upper().replace('-', '_')}"
    value = os.environ.get(env_key)
    if value is None:
        raise SecretNotFoundError(env_key)
    return value


def resolve_environment_values(env: dict[str, str]) -> dict[str, str]:
    """environment key/value 맵에서 vault 참조를 실값으로 치환."""
    resolved: dict[str, str] = {}
    for key, value in env.items():
        match = VAULT_REF_PATTERN.match(value) if isinstance(value, str) else None
        resolved[key] = resolve_secret(*match.groups()) if match else value
    return resolved


def resolve_vault_in_str(value: str) -> str:
    """문자열 내에 박힌 모든 vault 토큰을 실값으로 치환."""
    return VAULT_TOKEN_PATTERN.sub(lambda m: resolve_secret(m.group(1), m.group(2)), value)


def resolve_vault_deep(obj: object) -> object:
    """headers/body 등 임의 구조를 재귀 순회하며 vault 토큰을 리졸브.

    실제 API 호출 직전에만 호출하고, 반환값은 로그에 남기지 않는다.
    """
    if isinstance(obj, str):
        return resolve_vault_in_str(obj)
    if isinstance(obj, dict):
        return {k: resolve_vault_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [resolve_vault_deep(v) for v in obj]
    return obj
