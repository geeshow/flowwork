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
    "U1000": {"app_user_id": "U1000", "sec_user_id": "SEC-8F3A21", "CIF": "CIF001122", "name": "김철수", "phone": "010-1111-2222", "email": "chulsoo@example.com"},
    "U1001": {"app_user_id": "U1001", "sec_user_id": "SEC-2B7C90", "CIF": "CIF334455", "name": "이영희", "phone": "010-3333-4444", "email": "younghee@example.com"},
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

# sec_user_id로 조회하는 계좌 목록. 소유자(owner)/잔고(balance)는 중첩(다차원) 필드.
_SEC_ACCOUNTS = {
    "SEC-8F3A21": [
        {"accountNo": "110-222-333", "name": "김철수", "accountType": "펀드", "status": "ACTIVE", "openedAt": "2021-03-15", "closedAt": None,
         "owner": {"name": "김철수", "cif": "CIF001122"}, "balance": {"amount": 15230000, "currency": "KRW"}},
        {"accountNo": "110-444-555", "name": "김철수", "accountType": "신탁", "status": "CLOSED", "openedAt": "2019-07-01", "closedAt": "2023-02-10",
         "owner": {"name": "김철수", "cif": "CIF001122"}, "balance": {"amount": 0, "currency": "KRW"}},
    ],
    "SEC-2B7C90": [
        {"accountNo": "220-666-777", "name": "이영희", "accountType": "연금", "status": "ACTIVE", "openedAt": "2022-11-20", "closedAt": None,
         "owner": {"name": "이영희", "cif": "CIF334455"}, "balance": {"amount": 8400000, "currency": "KRW"}},
    ],
}


@app.get("/core/agreements/codes")
async def list_agreement_codes():
    return {"data": _AGREEMENT_CODES}


@app.get("/core/meta/codes/{code_group}")
async def get_meta_codes(code_group: str):
    return {"data": _META_CODES.get(code_group, [])}


@app.get("/core/users")
async def get_user(sec_user_id: str | None = None, cif: str | None = None):
    """sec_user_id 또는 CIF 중 하나로 사용자를 조회한다."""
    for u in _USERS.values():
        if (sec_user_id and u["sec_user_id"] == sec_user_id) or (cif and u["CIF"] == cif):
            return {"data": u}
    return {"data": None}


@app.get("/core/users/{app_user_id}")
async def get_user_by_app_id(app_user_id: str):
    return {"data": _USERS.get(app_user_id)}


@app.get("/core/users/{app_user_id}/accounts")
async def list_accounts(app_user_id: str, status: str | None = None):
    accounts = _ACCOUNTS.get(app_user_id, [])
    if status:
        accounts = [a for a in accounts if a["status"] == status]
    return {"data": accounts}


@app.get("/core/accounts")
async def list_accounts_by_sec(sec_user_id: str | None = None):
    """sec_user_id로 계좌 목록 조회 (계좌번호/이름/계좌타입/계좌상태/가입일자/해지일자)."""
    return {"data": _SEC_ACCOUNTS.get(sec_user_id, [])}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=9100)
