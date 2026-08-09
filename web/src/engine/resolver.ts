import { JSONPath } from "jsonpath-plus";

import type { Primitive, ValueSource } from "../types";

export interface ExecutionContext {
  userInputs: Record<string, Primitive>;
  stepResponses: Map<string, unknown>;
}

/**
 * ValueSource 한 개를 실제 값으로 리졸브한다.
 *
 * API_COMBO / DEPENDENT_LOOKUP은 실행 시점엔 이미 UI에서 값이 확정돼 있으므로
 * 실행 엔진 입장에선 USER_INPUT과 동일하게 취급된다. 4종 입력 타입 분기는
 * UI 레이어에만 존재하고 실행 코어는 오염되지 않는다.
 */
export function resolveValue(source: ValueSource, ctx: ExecutionContext): Primitive {
  switch (source.kind) {
    case "FIXED":
      return source.value;
    case "USER_INPUT":
      return ctx.userInputs[source.inputKey] ?? null;
    case "PREV_RESPONSE": {
      const body = ctx.stepResponses.get(source.stepId);
      if (body === undefined) {
        throw new Error(`이전 단계(${source.stepId})의 응답이 없습니다.`);
      }
      const result = JSONPath({ path: source.jsonPath, json: body as object, wrap: false });
      return (result ?? null) as Primitive;
    }
  }
}
