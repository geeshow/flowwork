"""데모 워크플로우 시드 (신 모델: 도메인/업무/기본입력값).

- payments/정산/'정산 취소 처리'      : 분기 + PREV_RESPONSE 체이닝
- demo/입력/'콤보·의존조회 데모'       : API_COMBO + DEPENDENT_LOOKUP 기본입력값

    python scripts/seed.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import catalog  # noqa: E402
from app.config import WORKFLOWS_DIR  # noqa: E402

# 카탈로그에서 이름으로 엔트리 id 조회 (API_COMBO/DEPENDENT_LOOKUP 소스용)
_entries, _ = catalog.build_index()
_by_name = {e.name: e.id for e in _entries}

SETTLEMENT_CANCEL = {
    "id": "wf_settlement_cancel",
    "domain": "payments",
    "task": "정산",
    "name": "정산 취소 처리",
    "description": "고객 정산을 조회하고, 상태가 ACTIVE면 취소한다.",
    "baseInputs": [
        {"kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string"},
        {
            "kind": "FIXED_COMBO",
            "key": "reason",
            "label": "취소 사유",
            "options": [
                {"label": "고객 요청", "value": "고객요청"},
                {"label": "중복 정산", "value": "중복정산"},
            ],
        },
    ],
    "steps": [
        {
            "id": "step_1",
            "order": 1,
            "name": "조회",
            "apiBinding": {
                "catalogEntry": {
                    "department": "payments",
                    "collectionFile": "settlement.postman_collection.json",
                    "itemPath": ["정산"],
                    "name": "정산 조회",
                },
                "variableBindings": {"customerId": {"kind": "USER_INPUT", "inputKey": "customerId"}},
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

COMBO_DEMO = {
    "id": "wf_combo",
    "domain": "demo",
    "task": "입력",
    "name": "콤보·의존조회 데모",
    "description": "API_COMBO로 고객 선택 → DEPENDENT_LOOKUP으로 이름/전화 확정 → 정산 조회",
    "baseInputs": [
        {
            "kind": "API_COMBO",
            "key": "customerId",
            "label": "고객 선택",
            "sourceApiId": _by_name.get("고객 목록", ""),
            "labelField": "name",
            "valueField": "id",
        },
        {
            "kind": "DEPENDENT_LOOKUP",
            "key": "customerInfo",
            "label": "고객 확인",
            "dependsOnKey": "customerId",
            "lookupApiId": _by_name.get("고객 조회", ""),
            "displayFields": ["name", "phone"],
        },
    ],
    "steps": [
        {
            "id": "step_1",
            "order": 1,
            "name": "조회",
            "apiBinding": {
                "catalogEntry": {
                    "department": "payments",
                    "collectionFile": "settlement.postman_collection.json",
                    "itemPath": ["정산"],
                    "name": "정산 조회",
                },
                "variableBindings": {"customerId": {"kind": "USER_INPUT", "inputKey": "customerId"}},
            },
        }
    ],
}


def _write(wf: dict) -> None:
    path = WORKFLOWS_DIR / wf["domain"] / wf["task"] / f"{wf['id']}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(wf, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"seeded: {path}")


def main() -> None:
    for wf in [SETTLEMENT_CANCEL, COMBO_DEMO]:
        _write(wf)


if __name__ == "__main__":
    main()
