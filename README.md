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

## 현재 상태

설계 단계 (POC). 권한 체크, Vault 연동 등은 POC 이후로 미루고 최소 구현으로 시작합니다.
