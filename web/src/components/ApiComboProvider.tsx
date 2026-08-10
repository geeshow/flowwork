import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react";

import { api } from "../api/client";
import { ComboCache, extractOne, extractRows, type ComboOption } from "../engine/comboCache";
import { resolveTemplate } from "../engine/template";
import type { CatalogEntry, EnvironmentValues, Primitive, StepApiBinding } from "../types";

interface ApiComboApi {
  /** API_COMBO: 소스 API를 호출해 {label,value} 옵션 목록 (캐시/중복호출 방지 적용). */
  getOptions: (sourceApiId: string, labelField: string, valueField: string) => Promise<ComboOption[]>;
  /** DEPENDENT_LOOKUP: 의존값으로 조회해 단일 결과 객체(부가정보) 반환. */
  lookup: (lookupApiId: string, dependsOnKey: string, dependValue: Primitive) => Promise<Record<string, unknown> | null>;
  /** DEPENDENT_COMBO: 의존값으로 목록 API를 호출해 {label,value} 옵션 목록 반환. */
  lookupList: (
    lookupApiId: string,
    dependsOnKey: string,
    dependValue: Primitive,
    labelField: string,
    valueField: string,
  ) => Promise<ComboOption[]>;
  /** 조회 API의 응답 필드 설명(필드명 → 한글 라벨) — 부가정보 표시에 사용. */
  outputLabels: (apiId: string) => Record<string, string>;
}

/** 프록시 호출 결과가 실패(HTTP 4xx/5xx 또는 네트워크 오류)면 메시지를 담아 던진다. */
function ensureOk(res: { response: { status: number | null; body: unknown } }): void {
  const { status, body } = res.response;
  if (status != null && status >= 200 && status < 400) return;
  const detail =
    body && typeof body === "object"
      ? String(
          (body as Record<string, unknown>).error ??
            (body as Record<string, unknown>).detail ??
            (body as Record<string, unknown>).message ??
            JSON.stringify(body).slice(0, 200),
        )
      : String(body ?? "");
  throw new Error(status == null ? `네트워크 오류: ${detail}` : `HTTP ${status}: ${detail}`);
}

const Ctx = createContext<ApiComboApi | null>(null);

const baseCtx = (env: EnvironmentValues) => ({
  userInputs: {},
  env,
  stepResponses: new Map<string, unknown>(),
});

function refBinding(entry: CatalogEntry, variableBindings: StepApiBinding["variableBindings"]): StepApiBinding {
  return {
    catalogEntry: {
      department: entry.department,
      collectionFile: entry.collectionFile,
      itemPath: entry.itemPath,
      name: entry.name,
    },
    variableBindings,
  };
}

/**
 * API_COMBO 캐시 Provider — 워크플로우 실행 화면 최상단(WorkflowRunner)에 배치해,
 * 워크플로우 세션이 바뀌면 캐시도 자연히 초기화되도록 한다.
 */
export function ApiComboProvider({
  entries,
  env,
  children,
}: {
  entries: CatalogEntry[];
  env: EnvironmentValues;
  children: ReactNode;
}) {
  const cacheRef = useRef(new ComboCache());
  const entryById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const getOptions = useCallback(
    async (sourceApiId: string, labelField: string, valueField: string) => {
      const entry = entryById.get(sourceApiId);
      if (!entry) throw new Error(`콤보 소스 API를 찾을 수 없습니다: ${sourceApiId}`);
      const key = `${sourceApiId}|${labelField}|${valueField}`;
      return cacheRef.current.get(key, async () => {
        const request = resolveTemplate(entry.requestTemplate, refBinding(entry, {}), baseCtx(env));
        const res = await api.invoke(request);
        ensureOk(res);
        return extractRows(res.response.body).map((row) => ({
          label: String(row[labelField]),
          value: String(row[valueField]),
        }));
      });
    },
    [entryById, env],
  );

  const lookup = useCallback(
    async (lookupApiId: string, dependsOnKey: string, dependValue: Primitive) => {
      const entry = entryById.get(lookupApiId);
      if (!entry) throw new Error(`조회 API를 찾을 수 없습니다: ${lookupApiId}`);
      // 의존값은 {{dependsOnKey}} 변수에 채운다 (조회 API의 변수명 = dependsOnKey 규약).
      // sec_user_id/CIF 처럼 "둘 중 하나"만 쓰는 API를 위해, 나머지 비-환경 변수는
      // 빈 문자열로 채워 미해결 에러를 막는다 (env 변수는 fallback으로 해결됨).
      const bindings: StepApiBinding["variableBindings"] = {};
      for (const v of entry.variables) {
        if (v === dependsOnKey) bindings[v] = { kind: "FIXED", value: dependValue };
        else if (!(v in env)) bindings[v] = { kind: "FIXED", value: "" };
      }
      const request = resolveTemplate(entry.requestTemplate, refBinding(entry, bindings), baseCtx(env));
      const res = await api.invoke(request);
      ensureOk(res);
      return extractOne(res.response.body);
    },
    [entryById, env],
  );

  const lookupList = useCallback(
    async (
      lookupApiId: string,
      dependsOnKey: string,
      dependValue: Primitive,
      labelField: string,
      valueField: string,
    ) => {
      const entry = entryById.get(lookupApiId);
      if (!entry) throw new Error(`조회 API를 찾을 수 없습니다: ${lookupApiId}`);
      const key = `list|${lookupApiId}|${dependsOnKey}|${dependValue}|${labelField}|${valueField}`;
      return cacheRef.current.get(key, async () => {
        // 의존값을 {{dependsOnKey}} 변수에 채우고, 나머지 비-환경 변수는 빈 값으로.
        const bindings: StepApiBinding["variableBindings"] = {};
        for (const v of entry.variables) {
          if (v === dependsOnKey) bindings[v] = { kind: "FIXED", value: dependValue };
          else if (!(v in env)) bindings[v] = { kind: "FIXED", value: "" };
        }
        const request = resolveTemplate(entry.requestTemplate, refBinding(entry, bindings), baseCtx(env));
        const res = await api.invoke(request);
        ensureOk(res);
        return extractRows(res.response.body).map((row) => ({
          label: String(row[labelField] ?? ""),
          value: String(row[valueField] ?? ""),
        }));
      });
    },
    [entryById, env],
  );

  const outputLabels = useCallback(
    (apiId: string) => entryById.get(apiId)?.outputLabels ?? {},
    [entryById],
  );

  const value = useMemo(
    () => ({ getOptions, lookup, lookupList, outputLabels }),
    [getOptions, lookup, lookupList, outputLabels],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApiCombo(): ApiComboApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApiCombo must be used within ApiComboProvider");
  return ctx;
}
