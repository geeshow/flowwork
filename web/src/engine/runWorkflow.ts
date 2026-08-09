import type {
  EnvironmentValues,
  ExecutionResult,
  PostmanRequest,
  Primitive,
  ResolvedRequest,
  StepExecutionState,
  Workflow,
  WorkflowStep,
  WorkflowStepResult,
} from "../types";
import { evaluateBranchCondition } from "./branch";
import { resolveValue, type ExecutionContext } from "./resolver";
import { resolveTemplate } from "./template";

/** 프록시 호출 결과 (서버 /api/proxy 응답 형태). */
export interface ProxyResult {
  response: { status: number | null; body: unknown };
}

export interface RunDeps {
  /** 스텝의 요청 템플릿을 공급 (카탈로그 조회 또는 inlineRequest). */
  getRequestTemplate: (step: WorkflowStep) => PostmanRequest;
  /** 서버 프록시 호출. 실행 이력 append는 서버가 담당. */
  proxy: (payload: {
    execution_id: string;
    step_id: string;
    workflow_id: string;
    request: ResolvedRequest;
  }) => Promise<ProxyResult>;
  env: EnvironmentValues;
  /** 다른 업무(워크플로우) 연결 스텝을 위해 하위 워크플로우를 로드. */
  getWorkflow?: (group: string, id: string) => Promise<Workflow> | Workflow;
  /** 기본 crypto.randomUUID. 테스트에서 주입 가능. */
  newExecutionId?: () => string;
}

export interface RunOptions {
  /** 재처리: 지정 스텝 이전은 건너뛰고, 미리 채운 응답으로 컨텍스트 시드. */
  resumeFrom?: {
    fromStepId: string;
    prefilledResponses: Map<string, unknown>;
  };
  /** 재처리 시 원본 실행 ID (이력에 참조로 남김). */
  retriedFromExecutionId?: string;
}

interface Runtime {
  executionId: string;
  stepPrefix: string; // 중첩 스텝 id를 유일하게 만들기 위한 접두사 (예: "step_1/")
  callStack: Set<string>; // 순환 참조 방지용 워크플로우 id 경로
  resumeFrom?: RunOptions["resumeFrom"];
}

const isOk = (status: number | null): boolean =>
  status !== null && status >= 200 && status < 300;

/**
 * 워크플로우 실행 진입점. 실행 로직은 전부 여기(프론트)에 있고,
 * 서버는 개별 API 호출 proxy만 담당한다.
 */
export async function runWorkflow(
  workflow: Workflow,
  userInputs: Record<string, Primitive>,
  deps: RunDeps,
  onStepUpdate: (state: StepExecutionState) => void,
  options: RunOptions = {},
): Promise<ExecutionResult> {
  const newId = deps.newExecutionId ?? (() => crypto.randomUUID());
  const executionId = newId();
  const result = await executeWorkflow(workflow, userInputs, deps, onStepUpdate, {
    executionId,
    stepPrefix: "",
    callStack: new Set([workflow.id]),
    resumeFrom: options.resumeFrom,
  });
  return { executionId, overallStatus: result.overallStatus };
}

/**
 * 실제 스텝 순회 루프. 하위 워크플로우 연결 시 자기 자신을 재귀 호출한다.
 * 각 워크플로우는 자신만의 ctx(로컬 step.id 기준)를 가지므로 분기/PREV_RESPONSE
 * 참조가 워크플로우 경계를 넘지 않는다.
 */
async function executeWorkflow(
  workflow: Workflow,
  userInputs: Record<string, Primitive>,
  deps: RunDeps,
  onStepUpdate: (state: StepExecutionState) => void,
  runtime: Runtime,
): Promise<{ overallStatus: "SUCCESS" | "FAILED"; stepResponses: Map<string, unknown> }> {
  const ctx: ExecutionContext = {
    userInputs,
    stepResponses: new Map(runtime.resumeFrom?.prefilledResponses ?? []),
  };
  let hadFailure = false;

  const orderedSteps = [...workflow.steps].sort((a, b) => a.order - b.order);
  let reached = runtime.resumeFrom === undefined;

  for (const step of orderedSteps) {
    const uid = `${runtime.stepPrefix}${step.id}`;

    // 재처리: 재개 지점 이전 스텝은 건너뛴다(응답은 prefilled로 이미 시드됨).
    if (!reached) {
      if (step.id === runtime.resumeFrom!.fromStepId) reached = true;
      else continue;
    }

    if (!evaluateBranchCondition(step, ctx)) {
      onStepUpdate({ stepId: uid, status: "SKIPPED" });
      continue;
    }

    onStepUpdate({ stepId: uid, status: "RUNNING" });

    try {
      const ok = step.workflowBinding
        ? await runWorkflowStep(step, workflow, ctx, deps, onStepUpdate, runtime, uid)
        : await runApiStep(step, workflow, ctx, deps, onStepUpdate, runtime, uid);

      if (!ok) {
        hadFailure = true;
        if (step.stopOnFailure) break;
      }
    } catch (e) {
      hadFailure = true;
      onStepUpdate({ stepId: uid, status: "FAILED", error: (e as Error).message });
      if (step.stopOnFailure) break;
    }
  }

  return { overallStatus: hadFailure ? "FAILED" : "SUCCESS", stepResponses: ctx.stepResponses };
}

/** API 호출 스텝. */
async function runApiStep(
  step: WorkflowStep,
  workflow: Workflow,
  ctx: ExecutionContext,
  deps: RunDeps,
  onStepUpdate: (state: StepExecutionState) => void,
  runtime: Runtime,
  uid: string,
): Promise<boolean> {
  if (!step.apiBinding) throw new Error("처리 API가 설정되지 않았습니다.");
  const template = deps.getRequestTemplate(step);
  const request = resolveTemplate(template, step.apiBinding, deps.env, ctx);

  const result = await deps.proxy({
    execution_id: runtime.executionId,
    step_id: uid,
    workflow_id: workflow.id,
    request,
  });

  ctx.stepResponses.set(step.id, result.response.body);
  const ok = isOk(result.response.status);
  onStepUpdate({ stepId: uid, status: ok ? "SUCCESS" : "FAILED", request, response: result.response.body });
  return ok;
}

/** 다른 업무(워크플로우) 연결 스텝 — 하위 워크플로우를 재귀 실행. */
async function runWorkflowStep(
  step: WorkflowStep,
  _workflow: Workflow,
  ctx: ExecutionContext,
  deps: RunDeps,
  onStepUpdate: (state: StepExecutionState) => void,
  runtime: Runtime,
  uid: string,
): Promise<boolean> {
  const wb = step.workflowBinding!;
  if (!deps.getWorkflow) throw new Error("워크플로우 연결이 지원되지 않습니다 (getWorkflow 미설정).");
  if (runtime.callStack.has(wb.ref.id)) {
    throw new Error(`워크플로우 순환 참조: ${wb.ref.id}`);
  }

  // 부모 컨텍스트 → 하위 워크플로우 입력값 매핑
  const subInputs: Record<string, Primitive> = {};
  for (const [key, source] of Object.entries(wb.inputMappings)) {
    subInputs[key] = resolveValue(source, ctx);
  }

  const subWorkflow = await deps.getWorkflow(wb.ref.group, wb.ref.id);
  const subResult = await executeWorkflow(subWorkflow, subInputs, deps, onStepUpdate, {
    executionId: runtime.executionId,
    stepPrefix: `${uid}/`,
    callStack: new Set([...runtime.callStack, subWorkflow.id]),
  });

  const response: WorkflowStepResult = {
    status: subResult.overallStatus,
    steps: Object.fromEntries(subResult.stepResponses),
  };
  ctx.stepResponses.set(step.id, response);

  const ok = subResult.overallStatus === "SUCCESS";
  onStepUpdate({ stepId: uid, status: ok ? "SUCCESS" : "FAILED", response });
  return ok;
}
