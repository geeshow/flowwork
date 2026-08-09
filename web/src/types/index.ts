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
// ---------------------------------------------------------------------------
export type ValueSource =
  | { kind: "USER_INPUT"; inputKey: string }
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

// ---------------------------------------------------------------------------
// 워크플로우 / 스텝
// ---------------------------------------------------------------------------
export type StepName = "조회" | "등록" | "폐쇄" | "수정";

export interface WorkflowStep {
  id: string;
  order: number;
  name: StepName | string;
  inputs: StepInputDef[];
  apiBinding: StepApiBinding;
  branchCondition?: BranchCondition;
  stopOnFailure?: boolean;
}

export interface Workflow {
  id: string;
  group: string;
  name: string;
  description?: string;
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
