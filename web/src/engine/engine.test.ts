import { describe, expect, it, vi } from "vitest";

import type {
  PostmanRequest,
  StepApiBinding,
  Workflow,
  WorkflowStep,
} from "../types";
import { evaluateBranchCondition } from "./branch";
import { resolveValue, type ExecutionContext } from "./resolver";
import { runWorkflow, type ProxyResult, type RunDeps } from "./runWorkflow";
import { resolveTemplate } from "./template";

function ctx(partial?: Partial<ExecutionContext>): ExecutionContext {
  return {
    userInputs: partial?.userInputs ?? {},
    stepResponses: partial?.stepResponses ?? new Map(),
  };
}

// ---------------------------------------------------------------------------
// resolver
// ---------------------------------------------------------------------------
describe("resolveValue", () => {
  it("FIXED는 값을 그대로 반환", () => {
    expect(resolveValue({ kind: "FIXED", value: 42 }, ctx())).toBe(42);
  });

  it("USER_INPUT은 컨텍스트에서, 없으면 null", () => {
    const c = ctx({ userInputs: { customerId: "C1" } });
    expect(resolveValue({ kind: "USER_INPUT", inputKey: "customerId" }, c)).toBe("C1");
    expect(resolveValue({ kind: "USER_INPUT", inputKey: "missing" }, c)).toBeNull();
  });

  it("PREV_RESPONSE는 jsonPath로 이전 응답에서 추출", () => {
    const c = ctx({
      stepResponses: new Map([["step_1", { data: { settlementId: "S99" } }]]),
    });
    const v = resolveValue(
      { kind: "PREV_RESPONSE", stepId: "step_1", jsonPath: "$.data.settlementId" },
      c,
    );
    expect(v).toBe("S99");
  });

  it("PREV_RESPONSE는 응답이 없으면 에러", () => {
    expect(() =>
      resolveValue({ kind: "PREV_RESPONSE", stepId: "nope", jsonPath: "$.x" }, ctx()),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// template
// ---------------------------------------------------------------------------
describe("resolveTemplate", () => {
  const template: PostmanRequest = {
    method: "post",
    header: [
      { key: "Authorization", value: "Bearer {{authToken}}" },
      { key: "Content-Type", value: "application/json" },
      { key: "X-Off", value: "no", disabled: true },
    ],
    url: { raw: "{{baseUrl}}/api/settlements/{{settlementId}}/cancel" },
    body: { mode: "raw", raw: '{"reason": "{{reason}}", "amount": {{amount}}}' },
  };

  const binding: StepApiBinding = {
    catalogEntry: { department: "payments", collectionFile: "x", itemPath: [], name: "취소" },
    variableBindings: {
      settlementId: { kind: "PREV_RESPONSE", stepId: "step_1", jsonPath: "$.data.settlementId" },
      reason: { kind: "FIXED", value: "고객요청" },
      amount: { kind: "USER_INPUT", inputKey: "amount" },
    },
  };

  it("env + 바인딩 + 컨텍스트를 합쳐 요청 완성, 메서드 대문자화, disabled 헤더 제외", () => {
    const c = ctx({
      userInputs: { amount: 1000 },
      stepResponses: new Map([["step_1", { data: { settlementId: "S99" } }]]),
    });
    const env = { baseUrl: "http://localhost:9100", authToken: "vault://payments/api-token" };

    const req = resolveTemplate(template, binding, env, c);

    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:9100/api/settlements/S99/cancel");
    // 시크릿은 vault 참조로 남아 서버가 최종 치환
    expect(req.headers.Authorization).toBe("Bearer vault://payments/api-token");
    expect(req.headers["X-Off"]).toBeUndefined();
    expect(req.body).toEqual({ reason: "고객요청", amount: 1000 });
  });

  it("리졸브 불가한 변수는 에러", () => {
    const bad: PostmanRequest = { method: "GET", url: { raw: "{{unknownVar}}/x" } };
    expect(() =>
      resolveTemplate(bad, { ...binding, variableBindings: {} }, {}, ctx()),
    ).toThrow(/unknownVar/);
  });
});

// ---------------------------------------------------------------------------
// branch
// ---------------------------------------------------------------------------
describe("evaluateBranchCondition", () => {
  const step = (cond?: WorkflowStep["branchCondition"]): WorkflowStep => ({
    id: "s2",
    order: 2,
    name: "폐쇄",
    inputs: [],
    apiBinding: { catalogEntry: { department: "", collectionFile: "", itemPath: [], name: "" }, variableBindings: {} },
    branchCondition: cond,
  });

  const c = ctx({
    stepResponses: new Map([["s1", { data: { status: "ACTIVE", count: 5, tags: ["a", "b"] } }]]),
  });

  it("조건 없으면 항상 실행", () => {
    expect(evaluateBranchCondition(step(), c)).toBe(true);
  });

  it("EQ 충족/불충족", () => {
    expect(evaluateBranchCondition(step({ sourceStepId: "s1", jsonPath: "$.data.status", operator: "EQ", compareValue: "ACTIVE" }), c)).toBe(true);
    expect(evaluateBranchCondition(step({ sourceStepId: "s1", jsonPath: "$.data.status", operator: "EQ", compareValue: "CLOSED" }), c)).toBe(false);
  });

  it("GT / EXISTS / CONTAINS", () => {
    expect(evaluateBranchCondition(step({ sourceStepId: "s1", jsonPath: "$.data.count", operator: "GT", compareValue: 3 }), c)).toBe(true);
    expect(evaluateBranchCondition(step({ sourceStepId: "s1", jsonPath: "$.data.missing", operator: "EXISTS" }), c)).toBe(false);
    expect(evaluateBranchCondition(step({ sourceStepId: "s1", jsonPath: "$.data.tags", operator: "CONTAINS", compareValue: "b" }), c)).toBe(true);
  });

  it("소스 스텝 응답이 없으면 불충족", () => {
    expect(evaluateBranchCondition(step({ sourceStepId: "unknown", jsonPath: "$.x", operator: "EXISTS" }), ctx())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runWorkflow (통합)
// ---------------------------------------------------------------------------
function makeWorkflow(): Workflow {
  const bind = (vb: StepApiBinding["variableBindings"] = {}): StepApiBinding => ({
    catalogEntry: { department: "payments", collectionFile: "settlement", itemPath: ["정산"], name: "x" },
    variableBindings: vb,
  });
  return {
    id: "wf_settlement_cancel",
    group: "payments",
    name: "정산 취소",
    steps: [
      {
        id: "step_1",
        order: 1,
        name: "조회",
        inputs: [],
        apiBinding: bind({ customerId: { kind: "USER_INPUT", inputKey: "customerId" } }),
      },
      {
        id: "step_2",
        order: 2,
        name: "폐쇄",
        inputs: [],
        branchCondition: { sourceStepId: "step_1", jsonPath: "$.data.status", operator: "EQ", compareValue: "ACTIVE" },
        apiBinding: bind({ settlementId: { kind: "PREV_RESPONSE", stepId: "step_1", jsonPath: "$.data.settlementId" } }),
        stopOnFailure: true,
      },
    ],
  };
}

const templateFor = (step: WorkflowStep): PostmanRequest => ({
  method: "GET",
  url: {
    raw: step.id === "step_1"
      ? "http://localhost:9100/{{customerId}}"
      : "http://localhost:9100/cancel/{{settlementId}}",
  },
});

function makeDeps(proxy: RunDeps["proxy"]): RunDeps {
  let n = 0;
  return {
    getRequestTemplate: templateFor,
    proxy,
    env: {},
    newExecutionId: () => `exec-${++n}`,
  };
}

describe("runWorkflow", () => {
  it("두 스텝 모두 성공하면 SUCCESS", async () => {
    const proxy = vi.fn(async (): Promise<ProxyResult> => ({
      response: { status: 200, body: { data: { status: "ACTIVE", settlementId: "S1" } } },
    }));
    const updates: string[] = [];
    const res = await runWorkflow(makeWorkflow(), { customerId: "C1" }, makeDeps(proxy), (s) =>
      updates.push(`${s.stepId}:${s.status}`),
    );
    expect(res.overallStatus).toBe("SUCCESS");
    expect(res.executionId).toBe("exec-1");
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(updates).toContain("step_2:SUCCESS");
  });

  it("분기 불충족이면 두번째 스텝 SKIPPED", async () => {
    const proxy = vi.fn(async (): Promise<ProxyResult> => ({
      response: { status: 200, body: { data: { status: "CLOSED" } } },
    }));
    const updates: string[] = [];
    const res = await runWorkflow(makeWorkflow(), { customerId: "C1" }, makeDeps(proxy), (s) =>
      updates.push(`${s.stepId}:${s.status}`),
    );
    expect(res.overallStatus).toBe("SUCCESS");
    expect(proxy).toHaveBeenCalledTimes(1); // step_2는 호출 안 됨
    expect(updates).toContain("step_2:SKIPPED");
  });

  it("stopOnFailure 스텝이 실패하면 이후 중단하고 FAILED", async () => {
    const proxy: RunDeps["proxy"] = vi
      .fn()
      .mockResolvedValueOnce({ response: { status: 200, body: { data: { status: "ACTIVE", settlementId: "S1" } } } })
      .mockResolvedValueOnce({ response: { status: 500, body: { error: "boom" } } });
    const updates: string[] = [];
    const res = await runWorkflow(makeWorkflow(), { customerId: "C1" }, makeDeps(proxy), (s) =>
      updates.push(`${s.stepId}:${s.status}`),
    );
    expect(res.overallStatus).toBe("FAILED");
    expect(updates).toContain("step_2:FAILED");
  });

  it("resumeFrom: 재개 지점 이전은 건너뛰고 prefilled 응답으로 진행", async () => {
    const proxy = vi.fn(async (): Promise<ProxyResult> => ({
      response: { status: 200, body: { ok: true } },
    }));
    const res = await runWorkflow(
      makeWorkflow(),
      { customerId: "C1" },
      makeDeps(proxy),
      () => {},
      {
        resumeFrom: {
          fromStepId: "step_2",
          prefilledResponses: new Map([["step_1", { data: { status: "ACTIVE", settlementId: "S1" } }]]),
        },
      },
    );
    expect(res.overallStatus).toBe("SUCCESS");
    expect(proxy).toHaveBeenCalledTimes(1); // step_1은 건너뜀
  });
});
