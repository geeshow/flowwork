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
│   ├── app/                     # catalog(Postman·bruno), storage, gitops(브랜치·머지), redaction, secrets
│   └── scripts/                 # seed / seed_groups / mock_upstream(:9100)
├── web/                         # 프론트엔드 (실행 엔진 + 등록/실행/이력 UI)
│   └── src/
│       ├── engine/              # resolver, template, branch, runWorkflow, comboCache
│       ├── components/          # StepCard, StepInputForm, ResultTable, HistoryView, editor/
│       └── types/
└── docs/architecture.md
```

### 데이터 저장소 (분리) — git 브랜치로 편집 관리

워크플로우 설정 데이터는 소스코드와 분리해
[geeshow/flowwork-workdata](https://github.com/geeshow/flowwork-workdata)에서 별도 버전 관리합니다.

```
flowwork-workdata/               # FLOWWORK_DATA_DIR가 가리키는 경로 (master 체크아웃 = 운영)
├── workflows/                   # {도메인}/{업무}/{id}.json
├── api-collections/             # {workspace}/{collection-id}.json
├── domains.json                 # 도메인 → 팔레트 색상 id 매핑
└── executions/                  # {execution_id}.jsonl (런타임 생성, git 제외)
flowwork-workdata-edit/          # 브랜치별 편집 worktree (서버가 자동 생성)
├── develop/                     # 편집 기본 뷰 + feature 머지 수행
└── feature__{이름}/             # 수정 모드 — 브랜치마다 전용 작업 공간
```

- **master** = 운영 데이터. "워크플로우" 메뉴(실행)는 항상 master 트리를 읽고, API로 직접 수정할 수 없다.
- **develop** = 편집 기준. "편집" 메뉴의 기본 뷰이자 feature 머지 대상.
- **feature/*** = 수정 모드. 브랜치마다 전용 worktree가 있어 **여러 명이 서로 다른 브랜치를
  동시에 편집**할 수 있고, 커밋 전 변경도 브랜치별로 독립 보존된다.

`server/.env`에 `FLOWWORK_DATA_DIR=/path/to/flowwork-workdata`를 설정해 연결합니다
(미설정 시 기본값 `server/data`). 편집 worktree 부모 경로는 `FLOWWORK_EDIT_DATA_DIR`
(기본 `{FLOWWORK_DATA_DIR}-edit`)로 바꿀 수 있습니다.

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
cd server && pytest          # 서버 46 케이스 (git 편집 플로우 포함)
cd web && npm test           # 실행 엔진 + 캐시 26 케이스
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

### 편집(git) — 코드처럼 리뷰·머지되는 워크플로우 데이터
- **워크플로우 메뉴는 실행 전용** — 등록/수정은 "편집" 메뉴로 분리 (운영 master 트리는 API 쓰기 403)
- **수정 모드 = URL의 브랜치** — `/editor/b/{branch}/…` 로 feature 브랜치를 URL에 담는다. 편집 메뉴 재진입(`/editor`)은 항상 develop(읽기 전용)으로 시작
- **브랜치별 worktree — 동시 편집** — 브랜치마다 전용 worktree를 두어 여러 명이 서로 다른 브랜치를 동시에 편집한다. 커밋 전 변경은 그 브랜치 worktree에 독립 보존되어 다른 브랜치 작업/재진입에 영향받지 않는다
- **커밋 전 로컬 임시 저장** — 저장은 브랜치 worktree 파일 쓰기라 서버 재시작에도 유지되고, 그 내용 그대로 실행해 동작 확인 가능
- **파일 상태 배지** — develop 대비 `수정됨(unstaged) → 스테이지 → 커밋됨 → 푸시됨` 을 워크플로우별로 표시. 사이드바에도 업무별 집계 배지, 도메인(상위 메뉴)에는 변경 알림 점
- **develop 머지** — 커밋 완료 후 버튼 한 번으로 --no-ff 머지(+push, develop worktree에서 수행). 완료 시 feature 브랜치/worktree 자동 정리, 충돌 시 해결 화면 제공
- **충돌 해결 화면** — develop/feature 두 버전을 **워크플로우 시각 비교(스텝 단위)** 와 **JSON 라인 diff** 로 좌우 비교하고, 해결안 JSON을 직접 편집해 확정 → 머지 커밋
- **운영 미반영 목록 + 운영 반영** — master vs develop 비교로 미반영 워크플로우를 나열하고, "운영 반영" 버튼으로 develop → master 병합 + push (운영 트리에서 수행, 워크플로우 메뉴에 즉시 반영)

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
| 편집(git) — feature 브랜치 수정 모드, 상태 배지, develop 머지, 충돌 해결(시각 비교+diff), 운영 미반영 목록 | ✅ |
| AI 워크플로우 추천, 권한 체크, 외부 Vault 연동, fan-out | ⏳ POC 이후 |

## API 명세 저장소

데모 API 명세는 Bruno 컬렉션으로도 관리됩니다 → [github.com/geeshow/flowwork-apis](https://github.com/geeshow/flowwork-apis)

## 현재 상태

POC 구현 단계. 권한 체크, 외부 Vault 연동 등은 [POC 이후](./docs/architecture.md#10-poc-스코프)로 미룹니다.
