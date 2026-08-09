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
from app.config import WORKFLOWS_DIR  # noqa: E402

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
        }
    ],
}

ACCOUNT_CLOSE = {
    "id": "account_close",
    "domain": "계좌",
    "task": "폐쇄",
    "name": "계좌 폐쇄",
    "description": "'사용자 조회' 업무를 연결해 고객을 확인한 뒤 정산을 조회한다.",
    "baseInputs": [
        {"kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string"}
    ],
    "steps": [
        {
            "id": "verify_user",
            "order": 1,
            "name": "조회",
            "workflowBinding": {
                "ref": {"id": "user_lookup"},
                "inputMappings": {"customerId": {"kind": "USER_INPUT", "inputKey": "customerId"}},
            },
        },
        {
            "id": "check_settlement",
            "order": 2,
            "name": "폐쇄",
            "apiBinding": {
                "catalogEntry": {
                    "department": "payments",
                    "collectionFile": "settlement.postman_collection.json",
                    "itemPath": ["정산"],
                    "name": "정산 조회",
                },
                "variableBindings": {
                    "customerId": {
                        "kind": "PREV_RESPONSE",
                        "stepId": "verify_user",
                        "jsonPath": "$.steps.lookup.data.id",
                    }
                },
            },
        },
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
    _placeholder("account_list", "계좌", "조회", "계좌 목록 조회"),
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
    for wf in [USER_LOOKUP, ACCOUNT_CLOSE, *PLACEHOLDERS]:
        _write(wf)


if __name__ == "__main__":
    main()
