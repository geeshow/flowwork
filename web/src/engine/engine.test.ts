import { describe, expect, it, vi } from "vitest";

import type {
  PostmanRequest,
  StepApiBinding,
  StepExecutionState,
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
    env: partial?.env ?? {},
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
      env: { baseUrl: "http://localhost:9100", authToken: "vault://payments/api-token" },
      stepResponses: new Map([["step_1", { data: { settlementId: "S99" } }]]),
    });

    const req = resolveTemplate(template, binding, c);

    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://localhost:9100/api/settlements/S99/cancel");
    // 시크릿은 vault 참조로 남아 서버가 최종 치환
    expect(req.headers.Authorization).toBe("Bearer vault://payments/api-token");
    expect(req.headers["X-Off"]).toBeUndefined();
    expect(req.body).toEqual({ reason: "고객요청", amount: 1000 });
  });

  it("ENV 소스는 환경변수값으로 리졸브", () => {
    const t: PostmanRequest = { method: "GET", url: { raw: "http://x/{{region}}" } };
    const b: StepApiBinding = {
      catalogEntry: { department: "", collectionFile: "", itemPath: [], name: "" },
      variableBindings: { region: { kind: "ENV", envKey: "REGION" } },
    };
    const req = resolveTemplate(t, b, ctx({ env: { REGION: "kr" } }));
    expect(req.url).toBe("http://x/kr");
  });

  it("리졸브 불가한 변수는 에러", () => {
    const bad: PostmanRequest = { method: "GET", url: { raw: "{{unknownVar}}/x" } };
    expect(() =>
      resolveTemplate(bad, { ...binding, variableBindings: {} }, ctx()),
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
    domain: "payments",
    task: "기본",
    name: "정산 취소",
    baseInputs: [],
    steps: [
      {
        id: "step_1",
        order: 1,
        name: "조회",
        apiBinding: bind({ customerId: { kind: "USER_INPUT", inputKey: "customerId" } }),
      },
      {
        id: "step_2",
        order: 2,
        name: "폐쇄",
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

  it("중간 입력: 스텝 성공 후 collectMidInputs 값을 병합해 다음 스텝이 사용", async () => {
    const bind = (vb: StepApiBinding["variableBindings"] = {}): StepApiBinding => ({
      catalogEntry: { department: "core", collectionFile: "c", itemPath: ["x"], name: "n" },
      variableBindings: vb,
    });
    const wf: Workflow = {
      id: "wf_mid",
      domain: "d",
      task: "t",
      name: "mid",
      baseInputs: [],
      steps: [
        {
          id: "step_1",
          order: 1,
          name: "목록",
          apiBinding: bind(),
          midInputs: [{ kind: "STEP_RESULT_COMBO", key: "picked", label: "선택", labelField: "name", valueField: "id" }],
        },
        {
          id: "step_2",
          order: 2,
          name: "처리",
          apiBinding: bind({ picked: { kind: "USER_INPUT", inputKey: "picked" } }),
          stopOnFailure: true,
        },
      ],
    };
    const proxy = vi.fn(async (_p: Parameters<RunDeps["proxy"]>[0]): Promise<ProxyResult> => ({
      response: { status: 200, body: { data: [{ id: "A1", name: "foo" }] } },
    }));
    const template = (s: WorkflowStep): PostmanRequest => ({
      method: "GET",
      url: { raw: s.id === "step_1" ? "http://localhost:9100/list" : "http://localhost:9100/use/{{picked}}" },
    });
    const collectMidInputs = vi.fn(
      async (_a: Parameters<NonNullable<RunDeps["collectMidInputs"]>>[0]) => ({ picked: "A1" }),
    );
    const deps: RunDeps = {
      getRequestTemplate: template,
      proxy,
      env: {},
      collectMidInputs,
      newExecutionId: () => "e1",
    };

    const res = await runWorkflow(wf, {}, deps, () => {});

    expect(res.overallStatus).toBe("SUCCESS");
    expect(collectMidInputs).toHaveBeenCalledTimes(1);
    // collectMidInputs는 방금 실행한 스텝의 응답(배열 body)을 받는다
    expect(collectMidInputs.mock.calls[0][0].response).toEqual({ data: [{ id: "A1", name: "foo" }] });
    // 병합된 값이 다음 스텝 요청에 반영된다
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls[1][0].request.url).toContain("A1");
  });

  it("중간 입력: 여러 스텝에서 순차로 받아 각각 다음 스텝에 반영", async () => {
    const bind = (vb: StepApiBinding["variableBindings"] = {}): StepApiBinding => ({
      catalogEntry: { department: "core", collectionFile: "c", itemPath: ["x"], name: "n" },
      variableBindings: vb,
    });
    const wf: Workflow = {
      id: "wf_seq",
      domain: "d",
      task: "t",
      name: "seq",
      baseInputs: [],
      steps: [
        {
          id: "step_1",
          order: 1,
          name: "목록1",
          apiBinding: bind(),
          midInputs: [{ kind: "STEP_RESULT_COMBO", key: "pick1", label: "1", labelField: "name", valueField: "id" }],
        },
        {
          id: "step_2",
          order: 2,
          name: "목록2",
          apiBinding: bind({ pick1: { kind: "USER_INPUT", inputKey: "pick1" } }),
          midInputs: [{ kind: "STEP_RESULT_COMBO", key: "pick2", label: "2", labelField: "name", valueField: "id" }],
        },
        {
          id: "step_3",
          order: 3,
          name: "처리",
          apiBinding: bind({ pick2: { kind: "USER_INPUT", inputKey: "pick2" } }),
          stopOnFailure: true,
        },
      ],
    };
    const proxy = vi.fn(async (_p: Parameters<RunDeps["proxy"]>[0]): Promise<ProxyResult> => ({
      response: { status: 200, body: { data: [{ id: "X", name: "n" }] } },
    }));
    const template = (s: WorkflowStep): PostmanRequest => ({
      method: "GET",
      url: {
        raw:
          s.id === "step_1"
            ? "http://localhost:9100/a"
            : s.id === "step_2"
              ? "http://localhost:9100/b/{{pick1}}"
              : "http://localhost:9100/c/{{pick2}}",
      },
    });
    // 순차 호출: 첫 번째는 pick1=A1, 두 번째는 pick2=B2
    const seen: string[] = [];
    const collectMidInputs = vi.fn(
      async (a: Parameters<NonNullable<RunDeps["collectMidInputs"]>>[0]) => {
        seen.push(a.step.id);
        return a.step.id === "step_1" ? { pick1: "A1" } : { pick2: "B2" };
      },
    );
    const deps: RunDeps = {
      getRequestTemplate: template,
      proxy,
      env: {},
      collectMidInputs,
      newExecutionId: () => "e1",
    };

    const res = await runWorkflow(wf, {}, deps, () => {});

    expect(res.overallStatus).toBe("SUCCESS");
    // 두 번, step_1 → step_2 순서로 중간 입력을 받았다
    expect(seen).toEqual(["step_1", "step_2"]);
    // step_2 요청엔 첫 중간입력(A1), step_3 요청엔 둘째 중간입력(B2)이 반영
    expect(proxy.mock.calls[1][0].request.url).toContain("A1");
    expect(proxy.mock.calls[2][0].request.url).toContain("B2");
  });

  it("중간 입력: 스텝이 실패하면 collectMidInputs를 호출하지 않는다", async () => {
    const bind = (vb: StepApiBinding["variableBindings"] = {}): StepApiBinding => ({
      catalogEntry: { department: "core", collectionFile: "c", itemPath: ["x"], name: "n" },
      variableBindings: vb,
    });
    const wf: Workflow = {
      id: "wf_mid2",
      domain: "d",
      task: "t",
      name: "mid2",
      baseInputs: [],
      steps: [
        { id: "step_1", order: 1, name: "목록", apiBinding: bind(), stopOnFailure: true, midInputs: [{ kind: "MANUAL", key: "x", label: "x", valueType: "string" }] },
      ],
    };
    const proxy = vi.fn(async (): Promise<ProxyResult> => ({ response: { status: 500, body: { error: "boom" } } }));
    const collectMidInputs = vi.fn(async () => ({ x: "1" }));
    const deps: RunDeps = {
      getRequestTemplate: () => ({ method: "GET", url: { raw: "http://localhost:9100/list" } }),
      proxy,
      env: {},
      collectMidInputs,
      newExecutionId: () => "e1",
    };
    const res = await runWorkflow(wf, {}, deps, () => {});
    expect(res.overallStatus).toBe("FAILED");
    expect(collectMidInputs).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 워크플로우 연결 (다른 업무를 스텝으로 연결)
// ---------------------------------------------------------------------------
function apiBinding(vb: StepApiBinding["variableBindings"] = {}): StepApiBinding {
  return {
    catalogEntry: { department: "g", collectionFile: "c", itemPath: [], name: "x" },
    variableBindings: vb,
  };
}

function subWorkflow(): Workflow {
  return {
    id: "sub_lookup",
    domain: "account",
    task: "기본",
    name: "사용자 조회(하위)",
    baseInputs: [],
    steps: [
      {
        id: "s_call",
        order: 1,
        name: "조회",
        apiBinding: apiBinding({ userId: { kind: "USER_INPUT", inputKey: "userId" } }),
      },
    ],
  };
}

function parentWorkflow(): Workflow {
  return {
    id: "parent_flow",
    domain: "account",
    task: "기본",
    name: "상위 업무",
    baseInputs: [],
    steps: [
      {
        id: "p1",
        order: 1,
        name: "조회",
        // 다른 업무(sub_lookup) 연결: 부모 입력 accountId → 하위 입력 userId
        workflowBinding: {
          ref: { id: "sub_lookup" },
          inputMappings: { userId: { kind: "USER_INPUT", inputKey: "accountId" } },
        },
      },
      {
        id: "p2",
        order: 2,
        name: "수정",
        // 하위 워크플로우 결과를 PREV_RESPONSE로 참조 ($.steps.<하위스텝id>...)
        apiBinding: apiBinding({
          name: { kind: "PREV_RESPONSE", stepId: "p1", jsonPath: "$.steps.s_call.data.name" },
        }),
      },
    ],
  };
}

describe("runWorkflow - 워크플로우 연결", () => {
  const template = (): PostmanRequest => ({ method: "GET", url: { raw: "http://localhost/x" } });

  function deps(proxy: RunDeps["proxy"], workflows: Record<string, Workflow>): RunDeps {
    let n = 0;
    return {
      getRequestTemplate: template,
      proxy,
      env: {},
      getWorkflow: (id) => workflows[id],
      newExecutionId: () => `exec-${++n}`,
    };
  }

  it("하위 워크플로우를 실행하고 입력 매핑 + 결과 참조가 동작", async () => {
    const proxy = vi.fn(async (_p: Parameters<RunDeps["proxy"]>[0]): Promise<ProxyResult> => ({
      response: { status: 200, body: { data: { name: "홍길동" } } },
    }));
    const updates: string[] = [];
    const res = await runWorkflow(
      parentWorkflow(),
      { accountId: "A1" },
      deps(proxy, { sub_lookup: subWorkflow() }),
      (s) => updates.push(`${s.stepId}:${s.status}`),
    );

    expect(res.overallStatus).toBe("SUCCESS");
    // 하위 스텝은 접두사 붙은 id로, 상위 스텝은 그대로
    expect(updates).toContain("p1/s_call:SUCCESS");
    expect(updates).toContain("p1:SUCCESS");
    expect(updates).toContain("p2:SUCCESS");

    // 하위 호출 step_id 접두사 + 상위 입력이 하위 입력으로 매핑됐는지
    const subCall = proxy.mock.calls.find((c) => c[0].step_id === "p1/s_call");
    expect(subCall).toBeTruthy();
    expect(proxy).toHaveBeenCalledTimes(2); // 하위 s_call + 상위 p2
  });

  it("순환 참조를 감지해 해당 스텝 실패", async () => {
    const selfRef: Workflow = {
      id: "loop",
      domain: "account",
    task: "기본",
      name: "자기참조",
      baseInputs: [],
      steps: [
        {
          id: "x",
          order: 1,
          name: "조회",
          workflowBinding: { ref: { id: "loop" }, inputMappings: {} },
        },
      ],
    };
    const proxy = vi.fn(async (): Promise<ProxyResult> => ({ response: { status: 200, body: {} } }));
    const updates: StepExecutionState[] = [];
    const res = await runWorkflow(selfRef, {}, deps(proxy, { loop: selfRef }), (s) => updates.push(s));

    expect(res.overallStatus).toBe("FAILED");
    const failed = updates.find((u) => u.status === "FAILED");
    expect(failed?.error).toMatch(/순환 참조/);
  });
});
