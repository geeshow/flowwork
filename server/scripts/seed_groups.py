"""도메인/업무 예시 시드 (신 모델).

도메인 → 업무 → 워크플로우(이름) 구조를 채운다.
- 계좌/사용자관리/'사용자 조회'  : 고객 조회 API (실행 가능)
- 계좌/폐쇄/'계좌 폐쇄'         : '사용자 조회' 업무를 연결 → 결과로 정산 조회 (실행 가능)
- 그 외는 목록/구조를 채우는 placeholder (스텝 없음, 편집으로 구성)

    python scripts/seed_groups.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import catalog  # noqa: E402
from app.config import WORKFLOWS_DIR  # noqa: E402


def _catalog_id(name: str) -> str:
    """카탈로그에서 API 이름으로 id(sha1)를 찾는다 (DEPENDENT_LOOKUP.lookupApiId용)."""
    entries, _ = catalog.build_index()
    for e in entries:
        if e.name == name:
            return e.id
    raise SystemExit(f"카탈로그에서 '{name}' 항목을 찾을 수 없습니다")

USER_LOOKUP = {
    "id": "user_lookup",
    "domain": "계좌",
    "task": "사용자관리",
    "name": "사용자 조회",
    "description": "고객 ID로 고객 정보를 조회한다.",
    "baseInputs": [
        {"kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string"}
    ],
    "steps": [
        {
            "id": "lookup",
            "order": 1,
            "name": "조회",
            "apiBinding": {
                "catalogEntry": {
                    "department": "customer",
                    "collectionFile": "customer-info.postman_collection.json",
                    "itemPath": ["고객"],
                    "name": "고객 조회",
                },
                "variableBindings": {"customerId": {"kind": "USER_INPUT", "inputKey": "customerId"}},
            },
            # 단일 객체 응답 → 필드/값 2열 표
            "resultView": {"mode": "TABLE", "columns": ["id", "name", "phone"]},
        }
    ],
}

def _account_close() -> dict:
    """계좌 폐쇄: app_user_id → (사용자조회로 sec_user_id 확정) → 계좌목록 콤보로
    계좌번호 선택 → 그 계좌를 폐쇄한다.

    - app_user_id      : 직접 입력(MANUAL)
    - sec_user_id      : 의존 조회(DEPENDENT_LOOKUP) — app_user_id로 사용자 조회
    - accountNo        : 의존 콤보(DEPENDENT_COMBO) — sec_user_id의 계좌목록에서 선택
    """
    return {
        "id": "account_close",
        "domain": "계좌",
        "task": "폐쇄",
        "name": "계좌 폐쇄",
        "description": "app_user_id로 사용자를 조회해 sec_user_id를 확정하고, 그 계좌 목록에서 폐쇄할 계좌를 골라 폐쇄한다.",
        "baseInputs": [
            {"kind": "MANUAL", "key": "app_user_id", "label": "앱 사용자 ID", "valueType": "string"},
            {
                "kind": "DEPENDENT_LOOKUP",
                "key": "sec_user_id",
                "label": "보안 사용자 ID",
                "dependsOnKey": "app_user_id",
                "lookupApiId": _catalog_id("사용자 정보 조회 (앱ID)"),
                "displayFields": ["name", "sec_user_id"],
                "valueField": "sec_user_id",
            },
            {
                "kind": "DEPENDENT_COMBO",
                "key": "accountNo",
                "label": "폐쇄할 계좌",
                "dependsOnKey": "sec_user_id",
                "lookupApiId": _catalog_id("계좌 목록 조회 (보안ID)"),
                "labelField": "accountType",
                "valueField": "accountNo",
            },
        ],
        "steps": [
            {
                "id": "close_account",
                "order": 1,
                "name": "계좌 폐쇄",
                "apiBinding": {
                    "catalogEntry": {
                        "department": "core",
                        "collectionFile": "core.postman_collection.json",
                        "itemPath": ["계좌"],
                        "name": "계좌 폐쇄",
                    },
                    "variableBindings": {
                        "accountNo": {"kind": "USER_INPUT", "inputKey": "accountNo"},
                        "reason": {"kind": "FIXED", "value": "고객 요청"},
                    },
                },
                "stopOnFailure": True,
                "resultView": {
                    "mode": "TABLE",
                    "columns": ["accountNo", "status", "closedAt", "reason"],
                },
            }
        ],
    }


def _account_list() -> dict:
    """계좌 목록 조회: CIF → (사용자 조회로 sec_user_id 자동 확정) → 계좌 목록 조회."""
    return {
        "id": "account_list",
        "domain": "계좌",
        "task": "조회",
        "name": "계좌 목록 조회",
        "description": "고객식별번호(CIF)로 사용자를 조회해 sec_user_id를 자동 확정하고, 그 계좌 목록을 조회한다.",
        "baseInputs": [
            {"kind": "MANUAL", "key": "CIF", "label": "고객식별번호(CIF)", "valueType": "string"},
            {
                "kind": "DEPENDENT_LOOKUP",
                "key": "sec_user_id",
                "label": "보안 사용자 ID",
                "dependsOnKey": "CIF",
                "lookupApiId": _catalog_id("사용자 정보 조회"),
                "displayFields": ["name", "sec_user_id"],
                "valueField": "sec_user_id",
            },
        ],
        "steps": [
            {
                "id": "step_accounts",
                "order": 1,
                "name": "계좌 목록 조회 (보안ID)",
                "apiBinding": {
                    "catalogEntry": {
                        "department": "core",
                        "collectionFile": "core.postman_collection.json",
                        "itemPath": ["계좌"],
                        "name": "계좌 목록 조회 (보안ID)",
                    },
                    "variableBindings": {
                        "sec_user_id": {"kind": "USER_INPUT", "inputKey": "sec_user_id"}
                    },
                },
                "stopOnFailure": True,
                "resultView": {
                    "mode": "TABLE",
                    "columns": ["accountNo", "name", "accountType", "status", "openedAt", "closedAt"],
                },
            }
        ],
    }


def _account_detail() -> dict:
    """계좌 상세 조회: 보안 ID로 계좌를 조회하고 소유자/잔고 등 중첩(다차원) 필드를 표로 표시."""
    return {
        "id": "account_detail",
        "domain": "계좌",
        "task": "조회",
        "name": "계좌 상세 조회",
        "description": "보안 사용자 ID로 계좌를 조회하고, 소유자·잔고 같은 중첩 필드까지 표로 보여준다.",
        "baseInputs": [
            {"kind": "MANUAL", "key": "sec_user_id", "label": "보안 사용자 ID", "valueType": "string"},
        ],
        "steps": [
            {
                "id": "step_detail",
                "order": 1,
                "name": "계좌 목록 조회 (보안ID)",
                "apiBinding": {
                    "catalogEntry": {
                        "department": "core",
                        "collectionFile": "core.postman_collection.json",
                        "itemPath": ["계좌"],
                        "name": "계좌 목록 조회 (보안ID)",
                    },
                    "variableBindings": {
                        "sec_user_id": {"kind": "USER_INPUT", "inputKey": "sec_user_id"}
                    },
                },
                # 중첩 필드는 점 표기 컬럼으로, 통째 객체 컬럼(owner/balance)은 압축 JSON으로
                "resultView": {
                    "mode": "TABLE",
                    "columns": [
                        "accountNo", "accountType",
                        "owner.name", "owner.cif", "balance.amount", "balance.currency",
                        "status", "tags", "owner", "balance",
                    ],
                },
            }
        ],
    }


def _placeholder(wf_id: str, domain: str, task: str, name: str) -> dict:
    return {
        "id": wf_id,
        "domain": domain,
        "task": task,
        "name": name,
        "description": "(스텝 미등록 — 편집에서 구성)",
        "baseInputs": [],
        "steps": [],
    }


PLACEHOLDERS = [
    _placeholder("account_open", "계좌", "개설", "계좌 개설"),
    _placeholder("account_open_resume_reset", "계좌", "개설", "계좌 개설 이어하기 초기화"),
    _placeholder("fund_balance_reset", "계좌", "초기화", "펀드 잔고 및 약정 초기화"),
    _placeholder("cash_balance_fx_reset", "계좌", "초기화", "출납 잔고 및 환전 내역 초기화"),
    _placeholder("order_fills_lookup", "매매", "체결내역", "주문체결내역 조회"),
    _placeholder("order_fills_delete", "매매", "체결내역", "주문체결내역 삭제"),
]


def _write(wf: dict) -> None:
    path = WORKFLOWS_DIR / wf["domain"] / wf["task"] / f"{wf['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(wf, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"seeded: {path}")


def main() -> None:
    for wf in [USER_LOOKUP, _account_close(), _account_list(), _account_detail(), *PLACEHOLDERS]:
        _write(wf)


if __name__ == "__main__":
    main()
