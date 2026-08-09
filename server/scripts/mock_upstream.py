"""데모용 목 업스트림 API (사내 API 대역).

정산 조회/취소 두 엔드포인트만 제공한다. 프록시 allowlist(localhost)에 걸리도록
포트 9100에서 뜬다.

    python scripts/mock_upstream.py
"""
from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="mock-upstream")

# 고객별 정산 상태 (데모 데이터)
_SETTLEMENTS = {
    "C1": {"settlementId": "S-1001", "status": "ACTIVE", "amount": 15000},
    "C2": {"settlementId": "S-1002", "status": "CLOSED", "amount": 0},
}

# 고객 마스터 (API_COMBO / DEPENDENT_LOOKUP 데모용)
_CUSTOMERS = {
    "C1": {"id": "C1", "name": "김철수", "phone": "010-1111-2222"},
    "C2": {"id": "C2", "name": "이영희", "phone": "010-3333-4444"},
}


@app.get("/payments/api/customers")
async def list_customers():
    return {"data": list(_CUSTOMERS.values())}


@app.get("/payments/api/customers/{customer_id}")
async def get_customer(customer_id: str):
    data = _CUSTOMERS.get(customer_id)
    if data is None:
        return {"data": None}
    return {"data": data}


@app.get("/payments/api/customers/{customer_id}/settlement")
async def get_settlement(customer_id: str):
    data = _SETTLEMENTS.get(customer_id)
    if data is None:
        return {"data": {"status": "NONE"}}
    return {"data": data}


class CancelBody(BaseModel):
    reason: str | None = None


@app.post("/payments/api/settlements/{settlement_id}/cancel")
async def cancel_settlement(settlement_id: str, body: CancelBody):
    return {"data": {"settlementId": settlement_id, "status": "CANCELLED", "reason": body.reason}}


# ---------------------------------------------------------------------------
# core API (약정/사용자/계좌/메타코드) — coreBaseUrl = http://localhost:9100/core
# ---------------------------------------------------------------------------
_AGREEMENT_CODES = [
    {"code": "FUND", "name": "펀드"},
    {"code": "TRUST", "name": "신탁"},
    {"code": "ISA", "name": "ISA"},
    {"code": "PENSION", "name": "연금"},
]

_META_CODES = {
    "account_status": [
        {"code": "ACTIVE", "name": "활성"},
        {"code": "DORMANT", "name": "휴면"},
        {"code": "CLOSED", "name": "해지"},
    ],
    "user_status": [
        {"code": "NORMAL", "name": "정상"},
        {"code": "LOCKED", "name": "잠금"},
        {"code": "WITHDRAWN", "name": "탈퇴"},
    ],
}

_USERS = {
    "U1000": {"app_user_id": "U1000", "name": "김철수", "phone": "010-1111-2222", "email": "chulsoo@example.com"},
    "U1001": {"app_user_id": "U1001", "name": "이영희", "phone": "010-3333-4444", "email": "younghee@example.com"},
}

_ACCOUNTS = {
    "U1000": [
        {"accountNo": "110-222-333", "status": "ACTIVE", "product": "펀드"},
        {"accountNo": "110-444-555", "status": "DORMANT", "product": "신탁"},
    ],
    "U1001": [
        {"accountNo": "220-666-777", "status": "ACTIVE", "product": "연금"},
    ],
}


@app.get("/core/agreements/codes")
async def list_agreement_codes():
    return {"data": _AGREEMENT_CODES}


@app.get("/core/meta/codes/{code_group}")
async def get_meta_codes(code_group: str):
    return {"data": _META_CODES.get(code_group, [])}


@app.get("/core/users/{app_user_id}")
async def get_user(app_user_id: str):
    return {"data": _USERS.get(app_user_id)}


@app.get("/core/users/{app_user_id}/accounts")
async def list_accounts(app_user_id: str, status: str | None = None):
    accounts = _ACCOUNTS.get(app_user_id, [])
    if status:
        accounts = [a for a in accounts if a["status"] == status]
    return {"data": accounts}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=9100)
