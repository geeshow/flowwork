"""서버 설정.

POC 스코프: 데이터 경로, SSRF 방지용 host allowlist, 프록시 타임아웃.
운영 전환 시 pydantic-settings/Vault 등으로 확장.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# server/ 디렉토리 기준 경로 (이 파일 = server/app/config.py)
SERVER_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("FLOWWORK_DATA_DIR", SERVER_ROOT / "data"))

WORKFLOWS_DIR = DATA_DIR / "workflows"
EXECUTIONS_DIR = DATA_DIR / "executions"
COLLECTIONS_DIR = DATA_DIR / "api-collections"  # API 콜렉션 (workspace/collection)
DOMAINS_FILE = DATA_DIR / "domains.json"  # 도메인 → 팔레트 색상 id 매핑

# 편집용 git worktree 부모 디렉토리 — 브랜치마다 하위에 별도 worktree를 두어
# 여러 브랜치를 동시에 편집할 수 있다: {EDIT_DATA_DIR}/{develop, feature__x, …}
# 편집 메뉴의 저장은 해당 브랜치 worktree에 쓰이고(=커밋 전 로컬 임시 저장),
# feature → develop 머지는 develop worktree에서 수행한다. 운영(master) 트리는 불변.
EDIT_DATA_DIR = Path(os.environ.get("FLOWWORK_EDIT_DATA_DIR", f"{DATA_DIR}-edit"))

# 편집 브랜치 체계
PROD_BRANCH = os.environ.get("FLOWWORK_PROD_BRANCH", "master")
EDIT_BASE_BRANCH = os.environ.get("FLOWWORK_EDIT_BASE_BRANCH", "develop")

# 브랜치명: 영문/숫자/한글/-/_/./ 만 허용, '..'과 선행 '-' 금지 (git 옵션/경로 주입 방지)
BRANCH_NAME_RE = re.compile(r"^[\w가-힣][\w가-힣./-]*$", re.UNICODE)


def check_branch_name(name: str) -> str:
    if not BRANCH_NAME_RE.match(name) or ".." in name:
        raise ValueError(f"허용되지 않는 브랜치 이름입니다: {name!r}")
    return name


def edit_worktree_path(branch: str | None) -> Path:
    """브랜치 → 편집 worktree 경로. 브랜치명 검증 포함 ('/'는 '__'로 치환)."""
    b = check_branch_name(branch or EDIT_BASE_BRANCH)
    return EDIT_DATA_DIR / b.replace("/", "__")

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
