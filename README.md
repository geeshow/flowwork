# flowwork

RestDocs / Postman Collection / Bruno로 수집된 사내 API를 조합해, 사용자가 필수 입력값만 채우면
**요청 → 응답 → 응답값 기반 재요청 → 응답**의 API 체이닝을 단계적으로 실행하는 워크플로우 도구.

n8n으로도 구현 가능한 영역이지만, 범용 그래프 편집기 특유의 학습 비용을 걷어내고
"등록 → 실행 → 실행 이력 관리"라는 좁은 시나리오에 맞춘 경량 도구를 지향합니다.

## 핵심 컨셉

- **API 카탈로그는 Postman Collection + Bruno(.bru)를 동시에 지원** — 변환 없이 그대로 읽고, 내부적으로 동일한 요청 모델로 정규화
- **부서/업무별로 Collection을 분리** — 폴더 구조가 곧 검색 스코프이자 스텝의 API 분류
- **실행 로직은 전부 프론트엔드(TypeScript)** — 값 리졸브, 분기 판단, 스텝 순회, 중간 입력을 브라우저에서 처리
- **서버(Python/FastAPI)는 얇게** — API 호출 proxy, 워크플로우 파일 CRUD, 실행 이력 append만 담당
- **시크릿은 서버가 호출 직전에만 리졸브** — `vault://` 참조는 프론트/로그에 원본이 남지 않음

## 문서

- [`docs/architecture.md`](./docs/architecture.md) — 전체 설계 상세 (데이터 모델, 실행 엔진, UI 레이어, API 카탈로그, 시크릿 관리)

## 프로젝트 구조

```
flowwork/
├── server/                      # FastAPI — proxy, 워크플로우 CRUD, 실행 이력
│   ├── main.py
│   ├── app/                     # catalog(Postman·bruno), storage, redaction, secrets
│   ├── scripts/                 # seed / seed_groups / mock_upstream(:9100)
│   └── data/
│       ├── workflows/           # {도메인}/{업무}/{id}.json
│       ├── api-catalog/
│       │   ├── environments/    # *.postman_environment.json / *.bru
│       │   ├── core/            # Bruno 컬렉션 (bruno.json + 폴더/*.bru)
│       │   └── {부서}/*.postman_collection.json
│       └── executions/          # {execution_id}.jsonl (append-only, 입력값·스텝 로그)
├── web/                         # 프론트엔드 (실행 엔진 + 등록/실행/이력 UI)
│   └── src/
│       ├── engine/              # resolver, template, branch, runWorkflow, comboCache
│       ├── components/          # StepCard, StepInputForm, ResultTable, HistoryView, editor/
│       └── types/
└── docs/architecture.md
```

## 실행 방법 (POC)

요구사항: Python 3.12+, Node 20+.

### 1. 서버 (FastAPI)

```bash
cd server
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 데모 워크플로우 시드 + 목 업스트림 API(:9100) 기동
python scripts/seed.py          # payments/정산, demo/입력 데모
python scripts/seed_groups.py   # 계좌·매매·정산 도메인 예시 (강제 폐쇄 = 업무 연결)
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

계좌 도메인의 **계좌 강제 폐쇄** 워크플로우에서 앱 사용자 ID `U1000` → 계좌 선택 → 거래 비밀번호
`0000`으로 실행하면, 매도·강제정산 업무 연결과 계좌 폐쇄까지 이어지는 체인을 볼 수 있습니다.
(데모 거래 비밀번호는 모든 계좌 공통 `0000`)

### 테스트

```bash
cd server && pytest          # 서버 27 케이스
cd web && npm test           # 실행 엔진 + 캐시 25 케이스
```

## 주요 기능

### 카탈로그 & 환경
- **Postman Collection v2.1 + Bruno(.bru) 동시 인덱싱** — 서버가 두 형식을 하나의 내부 요청 모델로 정규화(프론트 변경 없음). 데모의 `core`는 Bruno, `customer`/`payments`는 Postman으로 공존
- **응답 필드 명세** — Postman `_output` / Bruno `docs { output: ... }`로 응답 필드를 선언 → 결과 표 컬럼·의존 조회 값 필드 후보로 사용
- 환경변수 병합(`environments/*`), `vault://` 시크릿 참조

### 데이터 모델 & 탐색
- **도메인 → 업무 → 워크플로우** 3계층 (id 내부화, 이름은 (도메인·업무) 내 유일, 편집 시 파일 이동)
- 좌측 **도메인→업무 트리 사이드바** — 다중 열림, 폭 조절, 접기(localStorage 유지), 도메인 색상 불릿
- 도메인 전용 색상(임의 hex) 지정

### 입력값 종류 (기본 입력값)
| 종류 | 설명 |
|---|---|
| MANUAL | 직접 입력 — 문자열 / 숫자 / **비밀번호(마스킹)** |
| FIXED_COMBO | 고정 옵션 콤보 |
| API_COMBO | API 목록으로 콤보 (캐시 TTL 5분 + in-flight 공유) |
| DEPENDENT_LOOKUP | 의존 조회 — 의존값으로 단건 조회, 결과 필드 자동 확정(debounce) |
| DEPENDENT_COMBO | 의존 콤보 — 의존값으로 목록 API 호출 → 콤보(표현값/실제값) |

의존 key는 환경변수/기본입력/이전 조회 결과에서, 값/표시 필드는 API 명세(output)에서 선택.

### 스텝 처리
- **API 호출** 또는 **다른 업무(워크플로우) 연결(workflowBinding)** — 입력 매핑·결과 체이닝·순환 참조 방지
- 변수 바인딩 소스: **기본입력값 / 환경변수 / 고정값 / 전 단계 output(PREV_RESPONSE)**
- 분기 조건(EQ/NE/GT/LT/EXISTS/CONTAINS), 실패 시 이후 중단(stopOnFailure)
- **스텝 종류·분류 라벨** — API(`부서 > 폴더`) / 연결업무(`도메인 > 업무 > 업무명`)
- **결과 표시(원본/표)** — 응답에서 `data` 언랩 후: 배열→각 행, 객체→필드/값 2열, 중첩은 점 표기(`owner.name`), 배열/객체 셀→압축 JSON. 가로 스크롤(항상 보이는 커스텀 스크롤바)

### 중간 입력 (mid-flow input)
- 스텝이 성공하면 **다음 스텝 전에 추가 입력**을 받는다 — 실행이 그 자리에서 일시정지(폼) → "계속" → 재개
- 입력값은 이후 스텝이 참조. 종류: **STEP_RESULT_COMBO**(방금 스텝 응답 배열에서 콤보 선택), MANUAL
- 여러 스텝에서 순차로 수집 가능. 폼이 뜬 동안 그 스텝의 결과(표)를 함께 노출

### 실행 & 워크플로우 이력
- 실행 시 **유니크 URL(`/executions/{id}`) 생성·공유** — 해시 없는 History API 경로
- 공유 URL은 **실행 화면과 동일하게 렌더** — 스텝 이름·결과표·입력값까지. 중첩(업무 연결) 실행도 각 스텝을 자기 워크플로우로 해석해 이름/표 복원
- **워크플로우 이력** 화면 — 워크플로우와 동일한 도메인→업무 메뉴, `도메인 / 업무 / 작업명 [성공여부] 실행시간`으로 나열(업무 선택 시 필터)
- **사용된 입력값 기록** — 실행에 쓰인 기본+중간 입력을 이력에 남김(리댁션 — 비밀번호 등 마스킹)

### 보안
- 프록시 **SSRF allowlist** + `vault://` 시크릿(프론트 미노출, 호출 직전 리졸브)
- **로그 리댁션** — 요청 헤더/바디 + 응답 바디 + 입력값 (이력 저장분만; 실시간 응답은 체이닝 위해 전체 유지)

## 데모 워크플로우

`scripts/seed.py` + `scripts/seed_groups.py`로 시드됩니다.

| 도메인 / 업무 | 워크플로우 | 특징 |
|---|---|---|
| 계좌 / 폐쇄 | 계좌 폐쇄 | app_user_id → 사용자조회로 sec_user_id 확정 → 계좌 콤보 → 폐쇄 |
| 계좌 / 폐쇄 | **계좌 강제 폐쇄** | 위 flow 중간에 **매도·강제정산 두 업무를 연결** 후 폐쇄 |
| 계좌 / 출금 | 출금 | 의존 콤보로 계좌 선택 + 금액/비밀번호 |
| 계좌 / 출금 | 출금 (중간 선택) | 계좌 목록 조회 → **중간 입력**으로 계좌·금액·비밀번호 |
| 계좌 / 조회 | 계좌 목록/상세 조회 | 결과 표(1차원·중첩·배열 필드) |
| 매매 / 매도 | 매도 | 계좌번호+비밀번호로 전량 매도 |
| 정산 / 강제정산 | 강제 정산 | 계좌번호로 강제 정산 |
| payments / 정산 | 정산 취소 처리 | 조회→분기(ACTIVE만 취소) |

## 구현 현황

| 영역 | 상태 |
|---|---|
| 서버 proxy (SSRF allowlist + 시크릿 리졸브 + 로그 리댁션) | ✅ |
| 워크플로우 파일 CRUD (원자적 저장), 실행 이력 append/조회(JSONL) | ✅ |
| API 카탈로그 인메모리 인덱싱 — **Postman v2.1 + Bruno(.bru)** | ✅ |
| 실행 엔진 — 값 리졸버 / 템플릿 / 분기 / 실행 루프 / 재처리(resumeFrom) / **중간 입력** | ✅ |
| 입력 5종 — MANUAL(비밀번호 포함) / FIXED_COMBO / API_COMBO / DEPENDENT_LOOKUP / DEPENDENT_COMBO | ✅ |
| 워크플로우 합성 — 다른 업무 연결, 입력 매핑·결과 체이닝·순환 방지 | ✅ |
| 결과 표시 — 원본/표(배열·객체·중첩·배열필드), 가로 스크롤 | ✅ |
| 등록/편집 UI — 스텝 편집·정렬, 카탈로그 검색, 변수 바인딩, 분기, 중간 입력, 결과 컬럼 | ✅ |
| 워크플로우 이력 — 도메인→업무 메뉴, 공유 URL, 동일 렌더링, 입력값 기록 | ✅ |
| 라우팅 — 해시 없는 History API 경로 (정적 호스팅 시 SPA fallback 필요) | ✅ |
| AI 워크플로우 추천, 권한 체크, 외부 Vault 연동, fan-out | ⏳ POC 이후 |

## API 명세 저장소

데모 API 명세는 Bruno 컬렉션으로도 관리됩니다 → [github.com/geeshow/flowwork-apis](https://github.com/geeshow/flowwork-apis)

## 현재 상태

POC 구현 단계. 권한 체크, 외부 Vault 연동 등은 [POC 이후](./docs/architecture.md#10-poc-스코프)로 미룹니다.
