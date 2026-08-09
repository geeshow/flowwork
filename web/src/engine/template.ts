import type {
  EnvironmentValues,
  PostmanRequest,
  Primitive,
  ResolvedRequest,
  StepApiBinding,
} from "../types";
import { resolveValue, type ExecutionContext } from "./resolver";

const TEMPLATE_VAR = /\{\{(\w+)\}\}/g;

/** 문자열 내 {{var}}를 lookup 결과로 치환. 미해결 변수는 에러. */
function substitute(
  input: string,
  lookup: (name: string) => Primitive | undefined,
): string {
  return input.replace(TEMPLATE_VAR, (_, name: string) => {
    const value = lookup(name);
    if (value === undefined) {
      throw new Error(`변수 {{${name}}}를 리졸브할 수 없습니다.`);
    }
    return value === null ? "" : String(value);
  });
}

function rawUrl(url: PostmanRequest["url"]): string {
  if (typeof url === "string") return url;
  return url.raw ?? "";
}

/**
 * Postman 요청 템플릿 + 변수 바인딩 + 환경변수 + 실행 컨텍스트를 합쳐
 * 프록시로 보낼 준비가 된 ResolvedRequest를 만든다.
 *
 * 변수 우선순위: variableBindings(워크플로우 매핑) > environment(공통값).
 * 시크릿(vault:// 참조)은 environment 값에 그대로 남아 프록시가 최종 치환한다.
 */
export function resolveTemplate(
  request: PostmanRequest,
  binding: StepApiBinding,
  env: EnvironmentValues,
  ctx: ExecutionContext,
): ResolvedRequest {
  const lookup = (name: string): Primitive | undefined => {
    if (name in binding.variableBindings) {
      return resolveValue(binding.variableBindings[name], ctx);
    }
    if (name in env) return env[name];
    return undefined;
  };

  const method = request.method.toUpperCase();
  const url = substitute(rawUrl(request.url), lookup);

  const headers: Record<string, string> = {};
  for (const h of request.header ?? []) {
    if (h.disabled) continue;
    headers[h.key] = substitute(h.value, lookup);
  }

  let body: unknown;
  if (request.body?.mode === "raw" && request.body.raw) {
    const rawBody = substitute(request.body.raw, lookup);
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = rawBody; // JSON이 아니면 문자열 그대로
    }
  }

  return { method, url, headers, body };
}
