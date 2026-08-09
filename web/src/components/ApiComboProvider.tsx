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
}

const Ctx = createContext<ApiComboApi | null>(null);

const emptyCtx = () => ({ userInputs: {}, stepResponses: new Map<string, unknown>() });

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
        const request = resolveTemplate(entry.requestTemplate, refBinding(entry, {}), env, emptyCtx());
        const res = await api.invoke(request);
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
      const binding = refBinding(entry, { [dependsOnKey]: { kind: "FIXED", value: dependValue } });
      const request = resolveTemplate(entry.requestTemplate, binding, env, emptyCtx());
      const res = await api.invoke(request);
      return extractOne(res.response.body);
    },
    [entryById, env],
  );

  const value = useMemo(() => ({ getOptions, lookup }), [getOptions, lookup]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApiCombo(): ApiComboApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApiCombo must be used within ApiComboProvider");
  return ctx;
}
