import { JSONPath } from "jsonpath-plus";

import type { BranchCondition, WorkflowStep } from "../types";
import type { ExecutionContext } from "./resolver";

/**
 * 스텝의 분기 조건을 평가한다.
 *
 * - 조건이 없으면 항상 실행(true)
 * - 조건이 있으면 sourceStep 응답에서 jsonPath 값을 뽑아 연산자로 비교
 * - 소스 스텝의 응답이 아직 없으면(스킵됐거나 미실행) 조건 불충족으로 본다(false)
 */
export function evaluateBranchCondition(
  step: WorkflowStep,
  ctx: ExecutionContext,
): boolean {
  const cond = step.branchCondition;
  if (!cond) return true;

  const body = ctx.stepResponses.get(cond.sourceStepId);
  if (body === undefined) return false;

  const actual = JSONPath({ path: cond.jsonPath, json: body as object, wrap: false });
  return compare(actual, cond);
}

function compare(actual: unknown, cond: BranchCondition): boolean {
  const { operator, compareValue } = cond;
  switch (operator) {
    case "EXISTS":
      return actual !== undefined && actual !== null;
    case "EQ":
      return actual === compareValue;
    case "NE":
      return actual !== compareValue;
    case "GT":
      return typeof actual === "number" && typeof compareValue === "number"
        ? actual > compareValue
        : Number(actual) > Number(compareValue);
    case "LT":
      return typeof actual === "number" && typeof compareValue === "number"
        ? actual < compareValue
        : Number(actual) < Number(compareValue);
    case "CONTAINS":
      if (Array.isArray(actual)) return actual.includes(compareValue);
      return typeof actual === "string" && String(compareValue) !== ""
        ? actual.includes(String(compareValue))
        : false;
    default:
      return false;
  }
}
