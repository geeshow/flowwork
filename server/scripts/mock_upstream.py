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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=9100)
