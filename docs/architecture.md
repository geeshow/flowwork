# flowwork 아키텍처 설계

## 목차

1. [개요](#1-개요)
2. [워크플로우 등록/변경](#2-워크플로우-등록변경)
3. [데이터 모델](#3-데이터-모델)
4. [API 카탈로그 — Postman Collection 기반](#4-api-카탈로그--postman-collection-기반)
5. [실행 엔진 (프론트엔드)](#5-실행-엔진-프론트엔드)
6. [UI 레이어](#6-ui-레이어)
7. [서버 (Python/FastAPI)](#7-서버-pythonfastapi)
8. [CD 파이프라인 — API 카탈로그 동기화](#8-cd-파이프라인--api-카탈로그-동기화)
9. [시크릿 관리](#9-시크릿-관리)
10. [POC 스코프](#10-poc-스코프)

---

## 1. 개요

### 요구사항 요약

**워크플로우 등록/변경 순서**
1. 워크플로우 등록(그룹, 이름) 또는 기존 워크플로우 선택 후 수정
2. 세부 기능(조회/등록/폐쇄/수정) 단위로 스텝 등록
   - 필수 입력값 등록: 직접 입력 / API 검색 결과 콤보 / 고정값 콤보 / 입력값 기반 조회(의존 조회)
   - 처리 API 등록: 카탈로그 검색 후 등록 / 직접 입력, 응답 결과에 따른 추가 API 호출 분기

**워크플로우 사용**
1. 워크플로우 검색
2. 목록에서 선택
3. AI 질의를 통한 워크플로우 추천 → 실행 제안

**실행 시**
1. 단계별 성공/실패를 시각적으로 표시, 단계별 응답 로그 상세 확인 가능
2. 실행 히스토리 관리
3. 재처리 (재처리도 별도 실행으로 히스토리 관리)
4. 실행 히스토리 URL 공유

### 설계 원칙

- **서버는 상태를 최소한으로 갖는다.** 실행 로직(값 리졸브, 분기 판단)은 프론트에 있고, 서버는 API 호출 대행과 파일 CRUD만 한다.
- **API 스펙 포맷을 새로 만들지 않는다.** Postman Collection v2.1을 그대로 저장소 포맷으로 채택해 import/export 호환성을 얻는다.
- **읽기와 쓰기의 갱신 주기가 다른 데이터는 분리 관리한다.** API 카탈로그(일 1회 배치 갱신, 배포 시 스냅샷)와 워크플로우/실행 이력(런타임에 계속 쓰기)을 별도 파일 영역으로 나눈다.

---

## 2. 워크플로우 등록/변경

### 2.1 워크플로우 단위

| 필드 | 설명 |
|---|---|
| `group` | 워크플로우 그룹 (부서/업무 단위 분류) |
| `name` | 워크플로우 이름 |
| `steps[]` | 순서를 가진 스텝 목록 |

### 2.2 스텝(세부 기능) 단위

기능 이름은 조회 / 등록 / 폐쇄 / 수정 중 하나로 분류하고, 각 스텝은 아래 두 가지로 구성된다.

- **입력값 정의** (4종, [3.2](#32-입력값-정의-stepinput) 참고)
- **처리 API 바인딩** (Postman Collection 항목 + 변수 매핑, [4.4](#44-변수--valuesource-바인딩) 참고)

응답 결과에 따른 추가 API 호출 분기는 스텝에 선택적으로 붙는 `branchCondition`으로 표현한다 ([3.3](#33-분기-조건-branchcondition) 참고).

---

## 3. 데이터 모델

### 3.1 전체 구조

```
WorkflowGroup
 └─ Workflow (id, group, name)
     └─ WorkflowStep (id, order, name: 조회/등록/폐쇄/수정)
         ├─ StepInput[]        # 필수 입력값 정의 (4종)
         ├─ StepApiBinding     # 처리 API 1개 (Postman 카탈로그 참조 + 변수 매핑)
         └─ BranchCondition?   # 없으면 항상 실행, 있으면 이전 스텝 응답으로 스킵 여부 결정
```

### 3.2 입력값 정의 (StepInput)

```typescript
type StepInputDef =
  | { kind: "MANUAL"; key: string; label: string; valueType: "string" | "number" }
  | { kind: "API_COMBO"; key: string; label: string; sourceApiId: string; labelField: string; valueField: string }
  | { kind: "FIXED_COMBO"; key: string; label: string; options: { label: string; value: string }[] }
  | { kind: "DEPENDENT_LOOKUP"; key: string; label: string; dependsOnKey: string; lookupApiId: string; displayFields: string[] };
```

| 타입 | 설명 | 실행 시 UX |
|---|---|---|
| `MANUAL` | 사용자가 이름/값 형태로 직접 입력 | 텍스트/숫자 입력 필드 |
| `API_COMBO` | API 검색 결과값을 콤보로 제공 | 마운트 시 API 조회 → select 옵션 (같은 API는 캐싱, [5.3](#53-api_combo-캐싱) 참고) |
| `FIXED_COMBO` | 고정값 목록 콤보 | 정적 select 옵션 |
| `DEPENDENT_LOOKUP` | 입력값(예: ID)으로 API 조회해 이름/전화번호 등 부가정보 표시 | 조회 성공 시 값 자동 확정, 사용자에게 재입력 요구하지 않음 ([5.4](#54-dependent_lookup--조회-전용) 참고) |

실행 엔진 관점에서 이 4종은 결국 "값 하나를 만들어내는 리졸버"로 통일된다 ([5.1](#51-valuesource--리졸버) 참고).

### 3.3 분기 조건 (BranchCondition)

```typescript
interface BranchCondition {
  sourceStepId: string;
  jsonPath: string;
  operator: "EQ" | "NE" | "GT" | "LT" | "EXISTS" | "CONTAINS";
  compareValue?: string | number | boolean;
}
```

- 조건이 없으면 해당 스텝은 항상 실행
- 조건이 있고 불충족이면 `SKIPPED` 처리, 이후 스텝은 계속 진행
- 처음엔 이 연산자 세트로 시작하고, 자유 스크립트(JS 조건식) 허용은 실제 니즈가 확인된 뒤 추가 — 조건식을 스크립트로 열면 검증/보안 부담이 커짐

### 3.4 워크플로우 파일 예시

```json
{
  "id": "wf_settlement_cancel",
  "group": "payments",
  "name": "정산 취소 처리",
  "steps": [
    {
      "id": "step_1",
      "order": 1,
      "name": "조회",
      "inputs": [
        { "kind": "MANUAL", "key": "customerId", "label": "고객 ID", "valueType": "string" }
      ],
      "apiBinding": {
        "catalogEntry": { "department": "payments", "collectionFile": "settlement.postman_collection.json", "itemPath": ["정산"], "name": "정산 조회" },
        "variableBindings": { "customerId": { "kind": "USER_INPUT", "inputKey": "customerId" } }
      }
    },
    {
      "id": "step_2",
      "order": 2,
      "name": "폐쇄",
      "branchCondition": { "sourceStepId": "step_1", "jsonPath": "$.data.status", "operator": "EQ", "compareValue": "ACTIVE" },
      "inputs": [],
      "apiBinding": {
        "catalogEntry": { "department": "payments", "collectionFile": "settlement.postman_collection.json", "itemPath": ["정산"], "name": "정산 취소" },
        "variableBindings": {
          "settlementId": { "kind": "PREV_RESPONSE", "stepId": "step_1", "jsonPath": "$.data.settlementId" }
        }
      },
      "stopOnFailure": true
    }
  ]
}
```

---

## 4. API 카탈로그 — Postman Collection 기반

### 4.1 파일 구조 (부서/업무별 분리)

```
data/api-catalog/
├── payments/
│   ├── settlement.postman_collection.json
│   └── refund.postman_collection.json
├── customer/
│   └── customer-info.postman_collection.json
└── environments/
    ├── payments.postman_environment.json
    └── customer.postman_environment.json
```

- Postman에서 export한 `.postman_collection.json` / `.postman_environment.json`을 **변환 없이 그대로** 이 경로에 둔다 → Postman ↔ flowwork 왕복 import/export가 자동으로 성립
- Collection 내부의 폴더 구조(예: "정산" 폴더 아래 "정산 조회", "정산 취소")가 곧 업무별 분류이자 카탈로그 검색 시 breadcrumb

### 4.2 카탈로그 인덱싱

서버 기동 시 모든 Collection 파일을 읽어 폴더 트리를 평탄화해 검색 인덱스로 메모리에 적재한다.

```typescript
interface CatalogEntry {
  department: string;
  collectionFile: string;
  itemPath: string[];       // 폴더 breadcrumb
  name: string;
  method: string;
  url: string;
  requestTemplate: PostmanRequestItem["request"]; // 원본 그대로 보존
}
```

### 4.3 등록 화면에서의 "검색 후 등록"

부서 → 업무 폴더 → 개별 API 순으로 드릴다운하는 검색 UI. "직접 입력"은 카탈로그에 없는 API를 임시로 등록할 때의 예외 경로로 남겨둔다.

### 4.4 변수 → ValueSource 바인딩

Postman 요청은 `{{variable}}` 템플릿 문법을 쓴다:

```json
{
  "method": "POST",
  "url": { "raw": "{{baseUrl}}/api/customers/{{customerId}}/settle" },
  "body": { "mode": "raw", "raw": "{\"amount\": {{amount}}, \"reason\": \"{{reason}}\"}" }
}
```

- `{{baseUrl}}` 같은 collection 공통 값은 environment 파일에서 옴
- 그 외 변수(`{{customerId}}`, `{{amount}}` 등)는 워크플로우 등록 시 [ValueSource](#51-valuesource--리졸버)로 하나씩 매핑

```typescript
function extractTemplateVariables(entry: CatalogEntry): string[] {
  const raw = JSON.stringify(entry.requestTemplate);
  const matches = raw.matchAll(/\{\{(\w+)\}\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
}
```

등록 화면은 API를 선택하면 이 함수로 변수 목록을 뽑아 보여주고, 관리자가 변수마다 입력 소스(직접입력/API_COMBO/FIXED_COMBO/DEPENDENT_LOOKUP/이전 응답 참조) 중 하나를 고르는 방식으로 동작한다. 별도 매핑 스키마를 새로 설계할 필요가 없다.

---

## 5. 실행 엔진 (프론트엔드)

실행 로직은 서버가 아니라 브라우저에서 동작한다. 서버는 개별 API 호출의 proxy 역할만 한다.

### 5.1 ValueSource — 리졸버

```typescript
type Primitive = string | number | boolean | null;

type ValueSource =
  | { kind: "USER_INPUT"; inputKey: string }
  | { kind: "FIXED"; value: Primitive }
  | { kind: "PREV_RESPONSE"; stepId: string; jsonPath: string };

interface ExecutionContext {
  userInputs: Record<string, Primitive>;
  stepResponses: Map<string, unknown>;
}

function resolveValue(source: ValueSource, ctx: ExecutionContext): Primitive {
  switch (source.kind) {
    case "FIXED":
      return source.value;
    case "USER_INPUT":
      return ctx.userInputs[source.inputKey] ?? null;
    case "PREV_RESPONSE": {
      const body = ctx.stepResponses.get(source.stepId);
      if (body === undefined) throw new Error(`이전 단계(${source.stepId})의 응답이 없습니다.`);
      return JSONPath({ path: source.jsonPath, json: body, wrap: false }) ?? null;
    }
  }
}
```

`API_COMBO` / `DEPENDENT_LOOKUP`은 실행 시점엔 이미 UI에서 값이 확정된 상태이므로 실행 엔진 입장에선 `USER_INPUT`과 동일하게 취급된다. 4종의 입력 타입 분기는 UI 레이어에만 존재하고, 실행 코어는 오염되지 않는다.

### 5.2 실행 루프

```typescript
async function runWorkflow(
  workflow: Workflow,
  userInputs: Record<string, Primitive>,
  onStepUpdate: (state: StepExecutionState) => void
): Promise<{ executionId: string; overallStatus: "SUCCESS" | "FAILED" }> {
  const executionId = crypto.randomUUID();
  const ctx: ExecutionContext = { userInputs, stepResponses: new Map() };
  let hadFailure = false;

  for (const step of [...workflow.steps].sort((a, b) => a.order - b.order)) {
    if (!evaluateBranchCondition(step, ctx)) {
      onStepUpdate({ stepId: step.id, status: "SKIPPED" });
      continue;
    }
    onStepUpdate({ stepId: step.id, status: "RUNNING" });

    try {
      const request = resolveTemplate(step.apiBinding, ctx);
      const res = await fetch("/api/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execution_id: executionId, step_id: step.id, ...request }),
      });
      const logEntry = await res.json();
      ctx.stepResponses.set(step.id, logEntry.response.body);

      const ok = logEntry.response.status >= 200 && logEntry.response.status < 300;
      onStepUpdate({ stepId: step.id, status: ok ? "SUCCESS" : "FAILED", request, response: logEntry.response.body });
      if (!ok) {
        hadFailure = true;
        if (step.stopOnFailure) break;
      }
    } catch (e) {
      hadFailure = true;
      onStepUpdate({ stepId: step.id, status: "FAILED", error: (e as Error).message });
      if (step.stopOnFailure) break;
    }
  }

  return { executionId, overallStatus: hadFailure ? "FAILED" : "SUCCESS" };
}
```

**재처리(실패 지점부터 재개)**: `runWorkflow`에 `resumeFrom?: { fromStepId: string; prefilledResponses: Map<string, unknown> }`를 받아 `ctx.stepResponses`를 미리 채우고 루프 시작 지점만 건너뛰도록 확장 가능. 재처리도 새 `executionId`를 발급해 별도 이력으로 남기고, 원본 실행 ID는 `retriedFromExecutionId`로 참조만 남긴다.

### 5.3 API_COMBO 캐싱

같은 워크플로우 내 여러 스텝이 같은 `sourceApiId`를 참조할 수 있으므로, `WorkflowRunner` 스코프의 Context로 캐시를 둔다. 완료된 결과 캐시 + in-flight promise 공유로 중복 호출을 막는다.

```typescript
const CACHE_TTL_MS = 5 * 60 * 1000;

function useApiComboCache() {
  const cacheRef = useRef<Map<string, { data: ComboOption[]; fetchedAt: number }>>(new Map());
  const inFlightRef = useRef<Map<string, Promise<ComboOption[]>>>(new Map());

  const getOptions = async (apiId: string, labelField: string, valueField: string) => {
    const cached = cacheRef.current.get(apiId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

    const inFlight = inFlightRef.current.get(apiId);
    if (inFlight) return inFlight;

    const promise = fetch(`/api/catalog/invoke/${apiId}`)
      .then((r) => r.json())
      .then((rows: Record<string, unknown>[]) => {
        const options = rows.map((row) => ({ label: String(row[labelField]), value: String(row[valueField]) }));
        cacheRef.current.set(apiId, { data: options, fetchedAt: Date.now() });
        return options;
      })
      .finally(() => inFlightRef.current.delete(apiId));

    inFlightRef.current.set(apiId, promise);
    return promise;
  };

  return { getOptions };
}
```

캐시 Provider는 워크플로우 실행 화면 최상단(`WorkflowRunner`)에 배치해, 워크플로우 세션이 바뀌면 캐시도 자연히 초기화되도록 한다. 캐시 핵심 로직(TTL + in-flight 공유)은 React와 무관한 `ComboCache` 클래스로 분리해 단독 테스트하고, `ApiComboProvider`가 이를 감싼다.

> **소스 API 호출 경로**: 위 스케치는 전용 엔드포인트 `/api/catalog/invoke/{id}`를 가정했지만, 실제 구현은 **템플릿 리졸브를 프론트 한 곳에 유지**하기 위해 프론트가 소스 API의 Postman 템플릿을 `resolveTemplate`로 조립한 뒤 `execution_id` 없이 `/api/proxy`를 호출한다. 서버는 `execution_id`가 없으면 SSRF/시크릿 처리만 하고 **실행 이력에는 남기지 않는다**(콤보/조회는 워크플로우 스텝이 아니므로). 파이썬에 템플릿 리졸브를 중복 구현하지 않는 것이 목적이다.

### 5.4 DEPENDENT_LOOKUP — 조회 전용

사용자에게 값을 두 번 입력받지 않는다. 의존 필드(예: 고객 ID) 입력이 바뀌면 debounce(약 400ms) 후 조회 API를 호출하고, **조회 성공 시 그 결과를 스텝 입력값으로 바로 확정**한다. 화면에는 조회된 이름/전화번호 등 부가정보(`displayFields`)만 참고용으로 표시한다. 의존값은 조회 API 템플릿의 `{{dependsOnKey}}` 변수에 채워지는 규약(변수명 = `dependsOnKey`)을 따른다.

---

## 6. UI 레이어

### 6.1 스텝 카드 리스트

워크플로우의 각 스텝을 카드로 나열하고 실행 상태(`PENDING` / `RUNNING` / `SUCCESS` / `FAILED` / `SKIPPED`)를 색상과 아이콘으로 표시한다. 카드를 클릭하면 해당 스텝의 request/response 전체를 상세 패널(JSON 뷰어)로 확인할 수 있다.

### 6.2 입력 폼 4종

`StepInputForm`은 `StepInputDef.kind`에 따라 컴포넌트를 분기 렌더링하되, 부모(`values`, `onChange`)에게는 동일한 인터페이스로 노출한다.

| 컴포넌트 | 동작 |
|---|---|
| `ManualInput` | 텍스트/숫자 입력 |
| `FixedComboInput` | 정적 옵션 select |
| `ApiComboInput` | 마운트 시 캐시 경유 API 호출 → select 옵션 |
| `DependentLookupInput` | 의존값 변경 시 debounce 조회, 성공 시 값 자동 확정 + 참고정보 표시 |

폼의 최종 결과값(`Record<string, Primitive>`)이 곧 실행 엔진의 `ExecutionContext.userInputs`가 된다.

### 6.3 실행 히스토리 화면

- 목록: 워크플로우별 실행 이력 (실행 시각, 전체 상태, 실행자)
- 상세: `execution_id` 기준 스텝별 로그 — 스텝 카드 리스트와 동일한 컴포넌트 재사용
- 공유: `/executions/{execution_id}` 형태 URL로 상세 화면 직접 접근 가능

---

## 7. 서버 (Python/FastAPI)

서버 책임은 세 가지로 한정한다.

### 7.1 API 호출 proxy

```python
class ProxyRequest(BaseModel):
    execution_id: str
    step_id: str
    method: str
    url: str
    headers: dict[str, str] = {}
    body: dict | None = None

@app.post("/api/proxy")
async def proxy_call(req: ProxyRequest):
    if not any(req.url.startswith(p) for p in ALLOWED_HOST_PREFIXES):  # SSRF 방지 allowlist
        raise HTTPException(403, "허용되지 않은 API 호스트입니다")

    start = time.time()
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.request(req.method, req.url, headers=req.headers, json=req.body)
            status, resp_body = resp.status_code, safe_json(resp)
        except httpx.RequestError as e:
            status, resp_body = None, {"error": str(e)}

    log_entry = {
        "step_id": req.step_id,
        "request": redact_for_logging(req.model_dump()),  # 9.4 참고
        "response": {"status": status, "body": resp_body},
        "elapsed_ms": int((time.time() - start) * 1000),
        "timestamp": time.time(),
    }
    await append_execution_log(req.execution_id, log_entry)
    return log_entry
```

### 7.2 실행 이력 append / 조회

```python
async def append_execution_log(execution_id: str, entry: dict):
    path = f"data/executions/{execution_id}.jsonl"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    async with aiofiles.open(path, mode="a") as f:
        await f.write(json.dumps(entry, ensure_ascii=False) + "\n")

@app.get("/api/executions/{execution_id}")
async def get_execution(execution_id: str):
    path = f"data/executions/{execution_id}.jsonl"
    if not os.path.exists(path):
        raise HTTPException(404)
    async with aiofiles.open(path) as f:
        lines = await f.readlines()
    return {"execution_id": execution_id, "steps": [json.loads(l) for l in lines]}
```

JSONL append-only 구조라 동시 쓰기 락이 거의 필요 없다.

### 7.3 워크플로우 CRUD (파일 기반)

```python
@app.put("/api/workflows/{group}/{workflow_id}")
async def save_workflow(group: str, workflow_id: str, wf: WorkflowFile):
    path = f"data/workflows/{group}/{workflow_id}.json"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = path + ".tmp"
    async with aiofiles.open(tmp_path, "w") as f:
        await f.write(wf.model_dump_json(indent=2))
    os.replace(tmp_path, path)  # 원자적 교체
    return {"status": "saved"}
```

서버는 워크플로우 JSON의 스키마 유효성만 검증하고, 스텝 순서·분기 로직·값 리졸브 같은 "의미"는 다루지 않는다.

### 7.4 API 카탈로그 인메모리 인덱싱

카탈로그는 배포 단위로 고정되므로 기동 시 1회 로드한다.

```python
api_catalog_index: list[dict] = []
catalog_commit_sha: str | None = None

@app.on_event("startup")
async def load_catalog():
    global api_catalog_index, catalog_commit_sha
    api_catalog_index = [json.load(open(f)) for f in glob.glob("data/api-catalog/**/*.postman_collection.json", recursive=True)]
    sha_path = "data/api-catalog/.commit_sha"
    catalog_commit_sha = open(sha_path).read().strip() if os.path.exists(sha_path) else None

@app.get("/api/catalog/search")
async def search_catalog(q: str = ""):
    results = [e for e in api_catalog_index if q.lower() in e["name"].lower() or q.lower() in e["url"].lower()]
    return {"results": results[:50], "catalog_version": catalog_commit_sha}
```

---

## 8. CD 파이프라인 — API 카탈로그 동기화

- 별도 분석 배치가 **매일 1회** RestDocs / Postman Collection을 수집·정리해 GitHub 레포의 `cache-branch`에 push
- 서버는 **런타임에 GitHub 자격증명을 갖지 않는다.** CD(또는 컨테이너 빌드 / init container) 시점에만 스냅샷을 가져온다.

```bash
# CD 스크립트 예시 (tarball 방식 — git 불필요, 더 가벼움)
curl -L "https://codeload.github.com/{org}/flowwork/tar.gz/refs/heads/cache-branch" -o catalog.tar.gz
tar -xzf catalog.tar.gz --strip-components=2 -C data/api-catalog "flowwork-cache-branch/catalog"
```

갱신 주기(1일)와 배포 주기가 비슷하므로 별도 webhook 갱신 경로는 두지 않고, **매일 1회 CD 파이프라인을 크론으로 트리거**해 "카탈로그 분석 → cache-branch push → 서버 재배포"를 한 파이프라인으로 묶는다.

```yaml
schedule:
  - cron: "0 18 * * *"  # 매일 KST 03시
```

| 데이터 | 갱신 주체 | 갱신 시점 | 서버 권한 |
|---|---|---|---|
| API 카탈로그 | 분석 배치 | 배포 시 스냅샷 | 읽기 전용, GitHub 자격증명 불필요 |
| 워크플로우 정의 | 사용자 (등록/수정) | 런타임 | 파일 직접 쓰기 |
| 실행 이력 | 실행 엔진 | 런타임 (append) | 파일 직접 쓰기 |

---

## 9. 시크릿 관리

### 9.1 참조 문법

environment 파일에는 시크릿 실값 대신 참조만 남긴다. 분석 배치 산출물(cache-branch → git)에 평문이 들어갈 경로 자체를 차단하는 것이 목적이다.

```json
{
  "name": "payments-dev",
  "values": [
    { "key": "baseUrl", "value": "https://internal-api.kakaopay.com/payments", "enabled": true },
    { "key": "authToken", "value": "vault://payments/api-token", "enabled": true }
  ]
}
```

### 9.2 리졸브 시점

시크릿은 **프론트를 통과하는 동안 계속 `vault://scope/key` 참조 형태로만 존재**하고, 프록시가 실제 API를 호출하기 직전에만 실값으로 치환된다:

1. 서버가 environment 값을 프론트에 내려줄 때 vault 참조를 **그대로** 전달한다 (참조 문자열 자체는 시크릿이 아님).
2. 프론트는 템플릿 리졸브 시 `{{authToken}}` 자리에 `vault://...` 참조를 그대로 심는다 → 요청 헤더/바디에 참조가 박힌 상태로 프록시에 도착한다.
3. 프록시가 요청 구조(headers/body) 전체를 재귀 순회하며 vault 참조를 실값으로 치환한 **사본**을 만들어 그 사본으로만 upstream을 호출한다. 실값은 함수 스코프를 벗어나지 않고, 로그(원본 참조 기준)나 프론트 반환 응답에 포함되지 않는다.

```python
# 큰 문자열 안에 박힌 참조(예: "Bearer vault://payments/api-token")까지 치환
VAULT_TOKEN_PATTERN = re.compile(r"vault://([^/\s]+)/([^\s\"']+)")

def resolve_vault_in_str(value: str) -> str:
    return VAULT_TOKEN_PATTERN.sub(lambda m: resolve_secret(m.group(1), m.group(2)), value)

def resolve_vault_deep(obj):
    """headers/body 등 임의 구조를 재귀 순회하며 vault 참조를 리졸브. 호출 직전에만 사용."""
    if isinstance(obj, str):
        return resolve_vault_in_str(obj)
    if isinstance(obj, dict):
        return {k: resolve_vault_deep(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [resolve_vault_deep(v) for v in obj]
    return obj
```

> environment 맵 자체를 미리 치환하는 `resolve_environment_values`(단일 값 참조 `^vault://...$` 매칭)도 유틸로 남겨두지만, 실제 호출 경로에서는 "요청 조립 후 마지막에 요청 구조 전체를 리졸브"하는 위 방식을 쓴다. 프론트가 참조를 어디에 심었든(헤더 값 일부, 바디 등) 일괄 처리되고, 리졸브 지점이 프록시 한 곳으로 모인다.

### 9.3 시크릿 프로바이더

실사용 단계에서는 사내 Vault / AWS Secrets Manager 등으로 교체 가능하도록 인터페이스를 분리해둔다 (POC 단계 구현은 [10장](#10-poc-스코프) 참고).

### 9.4 로그 리댁션

실행 이력(JSONL)은 request/response를 기록하고, 이 이력은 URL로 공유되는 기능이므로 **시크릿이 로그에 남으면 공유 링크를 통해 그대로 유출**될 수 있다. 리댁션은 세 지점에서 적용한다:

- **요청 헤더**: 고정 키 목록(`authorization`, `x-api-key`, `cookie`) 마스킹
- **요청 body**: 민감해 보이는 필드명(`token`/`password`/`secret`/`apiKey`/`accessToken`/…)을 재귀 마스킹
- **응답 body**: 동일한 필드명 기준 재귀 마스킹

```python
REDACT_HEADER_KEYS = {"authorization", "x-api-key", "cookie"}

def redact_for_logging(request: dict) -> dict:
    redacted = {**request}
    if "headers" in redacted:
        redacted["headers"] = {
            k: ("***REDACTED***" if k.lower() in REDACT_HEADER_KEYS else v)
            for k, v in redacted["headers"].items()
        }
    if "body" in redacted:
        redacted["body"] = redact_body(redacted["body"])  # 필드명 기반 재귀 마스킹
    return redacted
```

**응답 리댁션의 핵심 제약**: 로그인류 API가 응답 body로 토큰을 돌려주면 그 토큰은 이후 스텝이 `PREV_RESPONSE`로 참조해 헤더에 넣을 수 있어야 한다. 따라서 리댁션은 **이력에 저장되는 사본에만** 적용하고, **프론트로 반환되는 실시간 응답은 전체를 유지**한다. (실시간 화면은 실행 당사자만 보고, URL로 공유되는 것은 리댁션된 JSONL 이력이다.)

필드명 기반 리댁션이 놓치는 경우(비표준 필드명 등)에 대비해, 실사용 단계에서는 변수 바인딩 시점의 "이 변수는 시크릿" 플래그로 명시적 마스킹을 보완한다.

---

## 10. POC 스코프

POC 단계에서는 **권한 체크와 외부 시크릿 스토어 연동을 제외**하고 최소 구현으로 시작한다.

### 포함

- `vault://scope/key` 참조 문법 (environment 파일에 평문 미포함)
- 환경변수 기반 단순 시크릿 리졸버

  ```python
  def resolve_secret(scope: str, key: str) -> str:
      env_key = f"SECRET_{scope.upper()}_{key.upper().replace('-', '_')}"
      value = os.environ.get(env_key)
      if value is None:
          raise SecretNotFoundError(env_key)
      return value
  ```

- 실행 로그 헤더 리댁션 ([9.4](#94-로그-리댁션))
- 프록시 SSRF 방지용 host allowlist

### 제외 (실사용 전환 시점에 추가)

- Vault / AWS Secrets Manager 연동, 시크릿 TTL 캐싱
- 부서 권한 체크 (SSO 연동 기반 실행 권한 스코프)
- 응답 배열 기반 fan-out 반복 호출 — 실제 니즈 확인 후 검토
- 자유 스크립트 기반 분기 조건 — 현재는 `jsonpath + 연산자` 세트로 제한

---

## 부록 A. AI 워크플로우 추천

워크플로우 이름/설명/스텝 요약을 임베딩해 pgvector에 저장하고, 사용자의 자연어 질의를 임베딩 후 유사도 검색으로 Top-N을 추천, "이 워크플로우를 실행할까요?"로 이어지는 흐름. 기존 Slack AI 문의 시스템(n8n + OpenAI + pgvector)과 동일한 패턴을 재사용할 수 있다. POC 이후 범위.

## 부록 B. 열린 질문

- Fan-out(응답 배열 → 반복 호출) 지원 여부와 범위
- 재처리 시 "전체 재실행"과 "실패 지점부터 재개" 중 기본 동작
- 부서 권한 체크를 어떤 사내 인증 체계(SSO 등)와 연동할지
