# flowwork

RestDocs / Postman Collection으로 수집된 사내 API를 조합해, 사용자가 필수 입력값만 채우면
**요청 → 응답 → 응답값 기반 재요청 → 응답**의 API 체이닝을 단계적으로 실행하는 워크플로우 도구.

n8n으로도 구현 가능한 영역이지만, 범용 그래프 편집기 특유의 학습 비용을 걷어내고
"등록 → 실행 → 실행 이력 관리"라는 좁은 시나리오에 맞춘 경량 도구를 지향합니다.

## 핵심 컨셉

- **API 카탈로그는 Postman Collection 포맷을 그대로 사용** — 변환 없이 import/export 왕복 호환
- **부서/업무별로 Collection 파일을 분리** — 폴더 구조가 곧 권한/검색 스코프
- **실행 로직은 전부 프론트엔드(TypeScript)** — 값 리졸브, 분기 판단, 스텝 순회를 브라우저에서 처리
- **서버(Python/FastAPI)는 얇게** — API 호출 proxy, 워크플로우 파일 CRUD, 실행 이력 append만 담당
- **API 카탈로그는 CD 배포 시점 스냅샷** — 별도 분석 배치가 매일 1회 결과를 `cache-branch`에 push, 서버는 배포 시 이를 받아 읽기 전용으로 사용

## 문서

- [`docs/architecture.md`](./docs/architecture.md) — 전체 설계 상세 (데이터 모델, 실행 엔진, UI 레이어, API 카탈로그, 시크릿 관리)

## 프로젝트 구조 (제안)

```
flowwork/
├── server/                  # FastAPI - proxy, 워크플로우 CRUD, 실행 이력
│   ├── main.py
│   ├── secrets/
│   └── data/
│       ├── workflows/       # {group}/{workflow_id}.json
│       ├── api-catalog/     # Postman Collection 원본 (부서/업무별 디렉토리)
│       │   ├── environments/
│       │   └── {department}/*.postman_collection.json
│       └── executions/      # {execution_id}.jsonl (append-only)
├── web/                     # 프론트엔드 (실행 엔진 + 등록/실행 UI)
│   └── src/
│       ├── engine/           # resolver, branch, runWorkflow
│       ├── components/       # StepCardList, StepInputForm 등
│       └── types/
└── docs/
    └── architecture.md
```

## 실행 방법 (POC)

요구사항: Python 3.12+, Node 20+.

### 1. 서버 (FastAPI)

```bash
cd server
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 데모 워크플로우 시드 + 목 업스트림 API(:9100) 기동
python scripts/seed.py
python scripts/mock_upstream.py &

# 시크릿(vault://payments/api-token) 리졸브용 환경변수와 함께 서버 기동(:8000)
SECRET_PAYMENTS_API_TOKEN=dev-token-example uvicorn main:app --port 8000
```

### 2. 프론트엔드 (Vite + React)

```bash
cd web
npm install
npm run dev        # http://localhost:5173 (→ :8000 프록시)
```

브라우저에서 "정산 취소 처리" 워크플로우를 열고 고객 ID `C1`(ACTIVE → 취소 실행) 또는
`C2`(CLOSED → 폐쇄 스텝 SKIPPED)로 실행 흐름/분기/이력을 확인할 수 있습니다.

### 테스트

```bash
cd server && pytest          # 서버 14 케이스
cd web && npm test           # 실행 엔진 14 케이스
```

## 구현 현황

| 영역 | 상태 |
|---|---|
| 서버 proxy (SSRF allowlist + 시크릿 리졸브 + 로그 리댁션) | ✅ |
| 워크플로우 파일 CRUD (원자적 저장) | ✅ |
| 실행 이력 append/조회 (JSONL), 공유 URL | ✅ |
| API 카탈로그 인메모리 인덱싱 (Postman v2.1) | ✅ |
| 실행 엔진: 값 리졸버 / 템플릿 / 분기 / 실행 루프 / 재처리(resumeFrom) | ✅ |
| UI: 스텝 카드(상태·JSON 상세), 입력 폼(MANUAL·FIXED_COMBO), 실행/이력 화면 | ✅ |
| 등록/편집 UI (스텝 편집·정렬, 카탈로그 검색, 변수→ValueSource 바인딩, 분기 조건) | ✅ |
| 입력 4종 실동작 — API_COMBO(캐시 TTL 5분+in-flight 공유), DEPENDENT_LOOKUP(debounce 조회·자동 확정) | ✅ |
| 로그 리댁션 — 요청 헤더/바디 + 응답 바디(이력 저장분만, 실시간 응답은 전체 유지) | ✅ |
| 워크플로우 목록 그룹 탭 (계좌/계정/매매/인증/마케팅/상품 …) | ✅ |
| 스텝 처리 = API 호출 **또는 다른 업무(워크플로우) 연결** — 입력 매핑·결과 체이닝·순환 참조 방지 | ✅ |
| AI 워크플로우 추천, 권한 체크, 외부 Vault 연동, fan-out, 재처리 UI | ⏳ POC 이후 |

### 워크플로우 합성 (다른 업무 연결)

스텝의 "처리 방식"을 **API 호출** 대신 **다른 업무 연결**로 지정하면, 그 스텝은 다른
워크플로우를 하위 실행한다. 부모의 입력값/이전 응답을 하위 워크플로우 입력으로 매핑하고,
하위 실행 결과는 `{ status, steps: { <하위스텝id>: 응답 } }` 형태로 노출되어 이후 스텝이
`PREV_RESPONSE`(`$.steps.<id>...`)로 참조할 수 있다. 순환 참조는 실행 시 감지해 차단한다.
데모: 계좌 그룹의 **계좌 폐쇄**(`사용자 조회` 업무를 연결 → 그 결과로 정산 조회).

그룹/업무 예시 시드: `python scripts/seed_groups.py`

## 현재 상태

POC 최소 구현 단계. 권한 체크, 외부 Vault 연동 등은 [POC 이후](./docs/architecture.md#10-poc-스코프)로 미룹니다.
