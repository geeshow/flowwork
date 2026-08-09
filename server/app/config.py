"""서버 설정.

POC 스코프: 데이터 경로, SSRF 방지용 host allowlist, 프록시 타임아웃.
운영 전환 시 pydantic-settings/Vault 등으로 확장.
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# server/ 디렉토리 기준 경로 (이 파일 = server/app/config.py)
SERVER_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("FLOWWORK_DATA_DIR", SERVER_ROOT / "data"))

WORKFLOWS_DIR = DATA_DIR / "workflows"
EXECUTIONS_DIR = DATA_DIR / "executions"
CATALOG_DIR = DATA_DIR / "api-catalog"

PROXY_TIMEOUT_SECONDS = float(os.environ.get("FLOWWORK_PROXY_TIMEOUT", "15.0"))


def _load_allowlist() -> list[str]:
    """프록시 대상 host allowlist (SSRF 방지).

    콤마로 구분된 URL prefix 목록. 비어있으면 프록시는 모든 호출을 거부한다
    (fail-closed). POC에서는 로컬 목 API를 위해 localhost를 기본 허용.
    """
    raw = os.environ.get(
        "FLOWWORK_ALLOWED_HOST_PREFIXES",
        "http://localhost,http://127.0.0.1",
    )
    return [p.strip() for p in raw.split(",") if p.strip()]


ALLOWED_HOST_PREFIXES: list[str] = _load_allowlist()
