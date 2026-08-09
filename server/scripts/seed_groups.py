"""그룹별 예시 업무 시드 (계좌 / 매매).

- 대부분은 목록/그룹 탭을 채우는 최소 워크플로우(스텝 없음 = 편집으로 채울 자리)
- 일부는 실제 실행 가능 + "다른 업무 연결"(워크플로우 합성) 데모:
    · 사용자 조회      : 고객 조회 API 호출 (customerId 입력)
    · 계좌 폐쇄        : ① '사용자 조회' 업무를 연결해 고객 확인 →
                         ② 그 결과(고객 id)로 정산 조회 API 호출

    python scripts/seed_groups.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import WORKFLOWS_DIR  # noqa: E402

# --- 실행 가능 + 링크 데모 ---------------------------------------------------

USER_LOOKUP = {
    "id": "user_lookup",
    "group": "계좌",
    "name": "사용자 조회",
    "description": "고객 ID로 고객 정보를 조회한다.",
    "steps": [
        {
            "id": "lookup",
            "order": 1,
            "name": "조회",
            "inputs": [
                {"kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string"}
            ],
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
    "group": "계좌",
    "name": "계좌 폐쇄",
    "description": "'사용자 조회' 업무를 연결해 고객을 확인한 뒤 정산을 조회한다.",
    "steps": [
        {
            "id": "verify_user",
            "order": 1,
            "name": "조회",
            "inputs": [
                {"kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string"}
            ],
            # 다른 업무(사용자 조회) 연결
            "workflowBinding": {
                "ref": {"group": "계좌", "id": "user_lookup"},
                "inputMappings": {"customerId": {"kind": "USER_INPUT", "inputKey": "customerId"}},
            },
        },
        {
            "id": "check_settlement",
            "order": 2,
            "name": "폐쇄",
            "inputs": [],
            # 연결한 업무의 결과(고객 id)로 정산 조회
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

# --- 그룹 탭을 채우는 placeholder(스텝은 편집으로 채울 자리) ------------------

def _placeholder(group: str, wf_id: str, name: str) -> dict:
    return {"id": wf_id, "group": group, "name": name, "description": "(스텝 미등록 — 편집에서 구성)", "steps": []}


PLACEHOLDERS = [
    _placeholder("계좌", "account_open", "계좌 개설"),
    _placeholder("계좌", "account_open_resume_reset", "계좌 개설 이어하기 초기화"),
    _placeholder("계좌", "account_list", "계좌 목록 조회"),
    _placeholder("계좌", "fund_balance_reset", "펀드 잔고 및 약정 초기화"),
    _placeholder("계좌", "cash_balance_fx_reset", "출납 잔고 및 환전 내역 초기화"),
    _placeholder("매매", "order_fills_lookup", "주문체결내역 조회"),
    _placeholder("매매", "order_fills_delete", "주문체결내역 삭제"),
]


def _write(wf: dict) -> None:
    path = WORKFLOWS_DIR / wf["group"] / f"{wf['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(wf, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"seeded: {path}")


def main() -> None:
    for wf in [USER_LOOKUP, ACCOUNT_CLOSE, *PLACEHOLDERS]:
        _write(wf)


if __name__ == "__main__":
    main()
