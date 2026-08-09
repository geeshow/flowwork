import type {
  EnvironmentValues,
  ExecutionResult,
  PostmanRequest,
  Primitive,
  ResolvedRequest,
  StepExecutionState,
  Workflow,
  WorkflowStep,
} from "../types";
import { evaluateBranchCondition } from "./branch";
import type { ExecutionContext } from "./resolver";
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

const isOk = (status: number | null): boolean =>
  status !== null && status >= 200 && status < 300;

/**
 * 워크플로우 실행 루프. 스텝을 order 순으로 순회하며
 * 분기 판단 → 템플릿 리졸브 → 프록시 호출 → 상태 콜백을 반복한다.
 * 실행 로직은 전부 여기(프론트)에 있고, 서버는 개별 호출 proxy만 담당한다.
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
  const ctx: ExecutionContext = {
    userInputs,
    stepResponses: new Map(options.resumeFrom?.prefilledResponses ?? []),
  };
  let hadFailure = false;

  const orderedSteps = [...workflow.steps].sort((a, b) => a.order - b.order);
  let reached = options.resumeFrom === undefined;

  for (const step of orderedSteps) {
    // 재처리: 재개 지점 이전 스텝은 건너뛴다(응답은 prefilled로 이미 시드됨).
    if (!reached) {
      if (step.id === options.resumeFrom!.fromStepId) reached = true;
      else continue;
    }

    if (!evaluateBranchCondition(step, ctx)) {
      onStepUpdate({ stepId: step.id, status: "SKIPPED" });
      continue;
    }

    onStepUpdate({ stepId: step.id, status: "RUNNING" });

    try {
      const template = deps.getRequestTemplate(step);
      const request = resolveTemplate(template, step.apiBinding, deps.env, ctx);

      const result = await deps.proxy({
        execution_id: executionId,
        step_id: step.id,
        workflow_id: workflow.id,
        request,
      });

      ctx.stepResponses.set(step.id, result.response.body);
      const ok = isOk(result.response.status);
      onStepUpdate({
        stepId: step.id,
        status: ok ? "SUCCESS" : "FAILED",
        request,
        response: result.response.body,
      });
      if (!ok) {
        hadFailure = true;
        if (step.stopOnFailure) break;
      }
    } catch (e) {
      hadFailure = true;
      onStepUpdate({
        stepId: step.id,
        status: "FAILED",
        error: (e as Error).message,
      });
      if (step.stopOnFailure) break;
    }
  }

  return { executionId, overallStatus: hadFailure ? "FAILED" : "SUCCESS" };
}
