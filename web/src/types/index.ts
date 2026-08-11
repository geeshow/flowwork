// flowwork 도메인 타입.
// 실행 코어가 다루는 값은 Primitive 하나로 수렴한다.

export type Primitive = string | number | boolean | null;

// ---------------------------------------------------------------------------
// 입력값 정의 (StepInput) — 4종. 실행 엔진에는 노출되지 않고 UI 레이어에만 존재.
// ---------------------------------------------------------------------------
export type StepInputDef =
  | { kind: "MANUAL"; key: string; label: string; valueType: "string" | "number" | "password" }
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
      // 조회 결과 객체에서 이 필드를 입력값으로 확정한다.
      // 없으면 의존값(dependsOnKey 값)을 그대로 사용(하위호환).
      valueField?: string;
    }
  | {
      // 의존 콤보 — 의존값(환경변수/기본입력/이전 조회 결과)으로 목록 API를 호출해
      // 그 결과(배열)를 콤보로 선택한다. labelField=표현값, valueField=실제값.
      kind: "DEPENDENT_COMBO";
      key: string;
      label: string;
      dependsOnKey: string;
      lookupApiId: string;
      labelField: string;
      valueField: string;
    }
  | {
      // 결과 콤보(중간 입력 전용) — 방금 실행한 스텝의 응답(배열)에서 콤보로 선택한다.
      // arrayPath 비우면 응답(또는 data 언랩) 자체가 배열이라고 본다.
      kind: "STEP_RESULT_COMBO";
      key: string;
      label: string;
      arrayPath?: string;
      labelField: string;
      valueField: string;
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

// 스텝 응답을 어떻게 보여줄지. RAW(원본 JSON) 또는 TABLE(표).
//   - 응답에서 data를 자동 언랩한 뒤:
//       배열이면  → 각 원소가 행, columns가 열
//       객체면    → 필드/값 2열 표 (columns는 표시할 필드)
//   - columns가 비어있으면 전체 필드를 자동 사용.
//   - columns 항목은 점 표기(예: owner.name)로 다차원 필드도 지정 가능.
export interface StepResultView {
  mode: "RAW" | "TABLE";
  columns: string[];
}

export interface WorkflowStep {
  id: string;
  order: number;
  name: StepName | string;
  // 처리 단계는 둘 중 하나: API 호출(apiBinding) 또는 다른 업무 연결(workflowBinding)
  apiBinding?: StepApiBinding;
  workflowBinding?: StepWorkflowBinding;
  branchCondition?: BranchCondition;
  stopOnFailure?: boolean;
  resultView?: StepResultView;
  // 중간 입력 — 이 스텝이 성공한 뒤, 다음 스텝 전에 사용자로부터 추가로 받는 입력.
  // 수집된 값은 userInputs에 병합되어 이후 스텝이 USER_INPUT으로 참조한다.
  midInputs?: StepInputDef[];
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
  // 낙관적 잠금 버전 (서버가 조회 시 채움 — 파일 내용 해시).
  // 저장 시 그대로 보내면, 그 사이 다른 사용자가 저장했을 때 서버가 409로 거부한다.
  version?: string;
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
  department: string; // workspace 이름
  collectionFile: string; // 콜렉션 id
  collectionName: string; // 콜렉션 표시 이름 (편집기 필터용)
  itemPath: string[];
  name: string;
  method: string;
  url: string;
  variables: string[];
  outputFields: string[]; // API 명세서상 응답(output) 필드명
  outputLabels: Record<string, string>; // 필드명 → 한글 설명(라벨)
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
