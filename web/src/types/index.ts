// flowwork 도메인 타입.
// 실행 코어가 다루는 값은 Primitive 하나로 수렴한다.

export type Primitive = string | number | boolean | null;

// ---------------------------------------------------------------------------
// 입력값 정의 (StepInput) — 4종. 실행 엔진에는 노출되지 않고 UI 레이어에만 존재.
// ---------------------------------------------------------------------------
export type StepInputDef =
  | { kind: "MANUAL"; key: string; label: string; valueType: "string" | "number" }
  | {
      kind: "API_COMBO";
      key: string;
      label: string;
      sourceApiId: string;
      labelField: string;
      valueField: string;
    }
  | {
      kind: "FIXED_COMBO";
      key: string;
      label: string;
      options: { label: string; value: string }[];
    }
  | {
      kind: "DEPENDENT_LOOKUP";
      key: string;
      label: string;
      dependsOnKey: string;
      lookupApiId: string;
      displayFields: string[];
    };

// ---------------------------------------------------------------------------
// 값 소스 (ValueSource) — 실행 엔진의 리졸버 대상
//   USER_INPUT    : 기본 입력값 (워크플로우 레벨 baseInputs)
//   ENV           : 환경변수값
//   FIXED         : 고정값
//   PREV_RESPONSE : 전 단계 output (배열/객체는 jsonPath로 고급 매핑)
// ---------------------------------------------------------------------------
export type ValueSource =
  | { kind: "USER_INPUT"; inputKey: string }
  | { kind: "ENV"; envKey: string }
  | { kind: "FIXED"; value: Primitive }
  | { kind: "PREV_RESPONSE"; stepId: string; jsonPath: string };

// ---------------------------------------------------------------------------
// 분기 조건 (BranchCondition)
// ---------------------------------------------------------------------------
export type BranchOperator = "EQ" | "NE" | "GT" | "LT" | "EXISTS" | "CONTAINS";

export interface BranchCondition {
  sourceStepId: string;
  jsonPath: string;
  operator: BranchOperator;
  compareValue?: string | number | boolean;
}

// ---------------------------------------------------------------------------
// API 바인딩 — 카탈로그 참조 + 변수 매핑
// ---------------------------------------------------------------------------
export interface CatalogEntryRef {
  department: string;
  collectionFile: string;
  itemPath: string[];
  name: string;
}

export interface StepApiBinding {
  catalogEntry: CatalogEntryRef;
  // 카탈로그 항목의 {{변수}} → ValueSource 매핑
  variableBindings: Record<string, ValueSource>;
  // 직접 입력 예외 경로(카탈로그에 없는 API)를 위한 인라인 요청 템플릿
  inlineRequest?: PostmanRequest;
}

// 처리 단계로 "다른 업무(워크플로우)"를 연결한다.
// 부모 컨텍스트(기본 입력값 / 이전 응답)를 하위 워크플로우의 기본 입력값으로 매핑해 실행한다.
export interface StepWorkflowBinding {
  ref: { id: string }; // 내부 id로 참조 (도메인/업무가 바뀌어도 id는 불변)
  // 하위 워크플로우 기본입력값 key → ValueSource (부모 컨텍스트 기준으로 리졸브)
  inputMappings: Record<string, ValueSource>;
}

// ---------------------------------------------------------------------------
// 워크플로우 / 스텝
// ---------------------------------------------------------------------------
export type StepName = "조회" | "등록" | "폐쇄" | "수정";

export interface WorkflowStep {
  id: string;
  order: number;
  name: StepName | string;
  // 처리 단계는 둘 중 하나: API 호출(apiBinding) 또는 다른 업무 연결(workflowBinding)
  apiBinding?: StepApiBinding;
  workflowBinding?: StepWorkflowBinding;
  branchCondition?: BranchCondition;
  stopOnFailure?: boolean;
}

// 워크플로우 스텝의 결과 형태 (이후 스텝이 PREV_RESPONSE로 참조 가능)
export interface WorkflowStepResult {
  status: "SUCCESS" | "FAILED";
  // 하위 스텝 id → 응답 body
  steps: Record<string, unknown>;
}

export interface Workflow {
  id: string; // 내부 식별자 (자동 생성, 사용자에게 노출/입력 안 함)
  domain: string; // 도메인 (구 group)
  task: string; // 업무
  name: string; // (도메인, 업무) 내에서 유일
  description?: string;
  baseInputs: StepInputDef[]; // 기본 입력값 (스텝보다 먼저 정의)
  steps: WorkflowStep[];
}

// ---------------------------------------------------------------------------
// Postman 요청 (카탈로그 원본 형태의 일부)
// ---------------------------------------------------------------------------
export interface PostmanUrl {
  raw?: string;
  host?: string[];
  path?: string[];
}

export interface PostmanHeader {
  key: string;
  value: string;
  disabled?: boolean;
}

export interface PostmanRequest {
  method: string;
  header?: PostmanHeader[];
  url: PostmanUrl | string;
  body?: { mode: string; raw?: string };
}

export interface CatalogEntry {
  id: string;
  department: string;
  collectionFile: string;
  itemPath: string[];
  name: string;
  method: string;
  url: string;
  variables: string[];
  requestTemplate: PostmanRequest;
}

// ---------------------------------------------------------------------------
// 실행 상태
// ---------------------------------------------------------------------------
export type StepStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "FAILED"
  | "SKIPPED";

export interface StepExecutionState {
  stepId: string;
  status: StepStatus;
  request?: ResolvedRequest;
  response?: unknown;
  error?: string;
}

// 리졸브 완료된, 프록시로 보낼 준비가 된 요청
export interface ResolvedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface ExecutionResult {
  executionId: string;
  overallStatus: "SUCCESS" | "FAILED";
}

// 환경변수 맵 (baseUrl 등 collection 공통값) — POC에선 프론트가 보유
export type EnvironmentValues = Record<string, string>;
