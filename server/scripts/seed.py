"""데모 워크플로우 시드.

architecture.md 3.4의 "정산 취소 처리" 예시를 실제 실행 가능한 형태로
data/workflows/payments/wf_settlement_cancel.json 에 기록한다.

    python scripts/seed.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import WORKFLOWS_DIR  # noqa: E402

WORKFLOW = {
    "id": "wf_settlement_cancel",
    "group": "payments",
    "name": "정산 취소 처리",
    "description": "고객 정산을 조회하고, 상태가 ACTIVE면 취소한다.",
    "steps": [
        {
            "id": "step_1",
            "order": 1,
            "name": "조회",
            "inputs": [
                {"kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string"}
            ],
            "apiBinding": {
                "catalogEntry": {
                    "department": "payments",
                    "collectionFile": "settlement.postman_collection.json",
                    "itemPath": ["정산"],
                    "name": "정산 조회",
                },
                "variableBindings": {
                    "customerId": {"kind": "USER_INPUT", "inputKey": "customerId"}
                },
            },
        },
        {
            "id": "step_2",
            "order": 2,
            "name": "폐쇄",
            "branchCondition": {
                "sourceStepId": "step_1",
                "jsonPath": "$.data.status",
                "operator": "EQ",
                "compareValue": "ACTIVE",
            },
            "inputs": [
                {
                    "kind": "FIXED_COMBO",
                    "key": "reason",
                    "label": "취소 사유",
                    "options": [
                        {"label": "고객 요청", "value": "고객요청"},
                        {"label": "중복 정산", "value": "중복정산"},
                    ],
                }
            ],
            "apiBinding": {
                "catalogEntry": {
                    "department": "payments",
                    "collectionFile": "settlement.postman_collection.json",
                    "itemPath": ["정산"],
                    "name": "정산 취소",
                },
                "variableBindings": {
                    "settlementId": {
                        "kind": "PREV_RESPONSE",
                        "stepId": "step_1",
                        "jsonPath": "$.data.settlementId",
                    },
                    "reason": {"kind": "USER_INPUT", "inputKey": "reason"},
                },
            },
            "stopOnFailure": True,
        },
    ],
}


def main() -> None:
    path = WORKFLOWS_DIR / WORKFLOW["group"] / f"{WORKFLOW['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(WORKFLOW, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"seeded: {path}")


if __name__ == "__main__":
    main()
