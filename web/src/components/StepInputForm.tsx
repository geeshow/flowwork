import { useEffect, useState } from "react";

import type { EnvironmentValues, Primitive, StepInputDef } from "../types";
import { useApiCombo } from "./ApiComboProvider";

interface Props {
  inputs: StepInputDef[];
  values: Record<string, Primitive>;
  env?: EnvironmentValues;
  // 중간 입력 폼일 때: 방금 실행한 스텝의 응답 (STEP_RESULT_COMBO 옵션 소스)
  stepResponse?: unknown;
  onChange: (key: string, value: Primitive) => void;
}

// STEP_RESULT_COMBO — 스텝 응답에서 배열을 뽑는다 (data 언랩 + arrayPath).
function unwrapData(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "data" in (body as object)) {
    return (body as { data: unknown }).data;
  }
  return body;
}
function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (o == null || typeof o !== "object") return undefined;
    return (o as Record<string, unknown>)[k];
  }, obj);
}
function rowsFromResponse(resp: unknown, arrayPath?: string): Record<string, unknown>[] {
  let base = unwrapData(resp);
  if (arrayPath) base = getByPath(base, arrayPath);
  return Array.isArray(base) ? (base as Record<string, unknown>[]) : [];
}

/**
 * 입력 폼 — StepInputDef.kind에 따라 분기 렌더링하되, 부모에게는 동일 인터페이스
 * (values, onChange)로 노출한다. 폼의 최종 결과값이 곧 실행 엔진의
 * ExecutionContext.userInputs가 된다.
 */
export function StepInputForm({ inputs, values, env, stepResponse, onChange }: Props) {
  if (inputs.length === 0) {
    return <p className="muted">사용자 입력 없음</p>;
  }
  return (
    <div className="input-form">
      {inputs.map((def) => (
        <label key={def.key} className="field">
          <span className="field-label">
            {def.label}
            <code className="field-key">{def.key}</code>
          </span>
          <InputControl def={def} values={values} env={env} stepResponse={stepResponse} onChange={onChange} />
        </label>
      ))}
    </div>
  );
}

function InputControl({
  def,
  values,
  env,
  stepResponse,
  onChange,
}: {
  def: StepInputDef;
  values: Record<string, Primitive>;
  env?: EnvironmentValues;
  stepResponse?: unknown;
  onChange: (key: string, value: Primitive) => void;
}) {
  switch (def.kind) {
    case "FIXED_COMBO":
      return (
        <select
          value={values[def.key] == null ? "" : String(values[def.key])}
          onChange={(e) => onChange(def.key, e.target.value)}
        >
          <option value="" disabled>
            선택…
          </option>
          {def.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );

    case "MANUAL":
      return (
        <input
          type={def.valueType === "number" ? "number" : def.valueType === "password" ? "password" : "text"}
          autoComplete={def.valueType === "password" ? "off" : undefined}
          value={values[def.key] == null ? "" : String(values[def.key])}
          onChange={(e) =>
            onChange(
              def.key,
              def.valueType === "number"
                ? e.target.value === ""
                  ? null
                  : Number(e.target.value)
                : e.target.value,
            )
          }
        />
      );

    case "API_COMBO":
      return <ApiComboInput def={def} value={values[def.key]} onChange={onChange} />;

    case "DEPENDENT_LOOKUP":
      return <DependentLookupInput def={def} value={values[def.key]} values={values} env={env} onChange={onChange} />;

    case "DEPENDENT_COMBO":
      return <DependentComboInput def={def} value={values[def.key]} values={values} env={env} onChange={onChange} />;

    case "STEP_RESULT_COMBO": {
      const options = rowsFromResponse(stepResponse, def.arrayPath).map((row) => ({
        label: String(row[def.labelField] ?? ""),
        value: String(row[def.valueField] ?? ""),
      }));
      if (options.length === 0) return <span className="hint">선택할 결과가 없습니다.</span>;
      return (
        <select value={values[def.key] == null ? "" : String(values[def.key])} onChange={(e) => onChange(def.key, e.target.value)}>
          <option value="" disabled>
            선택…
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label !== o.value ? `${o.label} (${o.value})` : o.label}
            </option>
          ))}
        </select>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// API_COMBO — 마운트 시 캐시 경유로 소스 API를 조회해 select 옵션 렌더링
// ---------------------------------------------------------------------------
function ApiComboInput({
  def,
  value,
  onChange,
}: {
  def: Extract<StepInputDef, { kind: "API_COMBO" }>;
  value: Primitive | undefined;
  onChange: (key: string, value: Primitive) => void;
}) {
  const { getOptions } = useApiCombo();
  const [options, setOptions] = useState<{ label: string; value: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    setOptions(null);
    getOptions(def.sourceApiId, def.labelField, def.valueField)
      .then((o) => alive && setOptions(o))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [def.sourceApiId, def.labelField, def.valueField, getOptions]);

  if (error) return <span className="hint error-text">옵션 조회 실패: {error}</span>;
  if (!options) return <span className="hint">옵션 불러오는 중…</span>;

  return (
    <select value={value == null ? "" : String(value)} onChange={(e) => onChange(def.key, e.target.value)}>
      <option value="" disabled>
        선택…
      </option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// DEPENDENT_LOOKUP — 의존값 변경 시 debounce 조회, 성공하면 값 자동 확정 + 부가정보 표시
// ---------------------------------------------------------------------------
function DependentLookupInput({
  def,
  value,
  values,
  env,
  onChange,
}: {
  def: Extract<StepInputDef, { kind: "DEPENDENT_LOOKUP" }>;
  value: Primitive | undefined;
  values: Record<string, Primitive>;
  env?: EnvironmentValues;
  onChange: (key: string, value: Primitive) => void;
}) {
  const { lookup, outputLabels } = useApiCombo();
  // 의존 입력 key는 기본입력값 또는 환경변수에서 온다.
  const dependValue = values[def.dependsOnKey] ?? env?.[def.dependsOnKey] ?? null;
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  // 조회 실패 사유 — API 오류면 그 메시지, 결과가 없으면 안내 문구
  const [failReason, setFailReason] = useState<string | null>(null);

  useEffect(() => {
    if (dependValue == null || dependValue === "") {
      setInfo(null);
      setStatus("idle");
      setFailReason(null);
      if (value != null) onChange(def.key, null);
      return;
    }
    let alive = true;
    setStatus("loading");
    setFailReason(null);
    const t = setTimeout(() => {
      lookup(def.lookupApiId, def.dependsOnKey, dependValue)
        .then((row) => {
          if (!alive) return;
          if (row) {
            // valueField가 있으면 조회 결과의 그 필드를, 없으면 의존값을 확정값으로.
            const picked = def.valueField
              ? ((row[def.valueField] as Primitive) ?? null)
              : dependValue;
            setInfo(row);
            setStatus("ok");
            onChange(def.key, picked); // 조회 성공 시 값 자동 확정
          } else {
            setInfo(null);
            setStatus("fail");
            setFailReason("조회 결과가 없습니다");
            onChange(def.key, null);
          }
        })
        .catch((e) => {
          if (alive) {
            setStatus("fail");
            setFailReason((e as Error).message);
            onChange(def.key, null);
          }
        });
    }, 400); // debounce
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // onChange/value는 의도적으로 제외 (의존값 변경 시에만 재조회)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependValue, def.lookupApiId, def.dependsOnKey, def.key]);

  return (
    <div className="dependent-lookup">
      <div className="dependent-value">
        <code>{def.dependsOnKey}</code> = {dependValue == null || dependValue === "" ? <span className="muted">미입력</span> : String(dependValue)}
        {status === "loading" ? <span className="hint"> 조회 중…</span> : null}
        {status === "ok" ? (
          <span className="hint ok-text">
            {" "}✓ {def.valueField ? <><code>{def.key}</code> = {value == null ? "-" : String(value)}</> : "확정"}
          </span>
        ) : null}
        {status === "fail" ? <span className="hint error-text"> 조회 실패</span> : null}
      </div>
      {status === "fail" && failReason ? (
        <div className="lookup-fail-reason error-text">{failReason}</div>
      ) : null}
      {status === "ok" && info ? (
        <div className="lookup-info">
          {def.displayFields.map((f) => {
            // 필드 설명(한글 라벨)이 있으면 설명을, 없으면 필드명을 표시
            const label = outputLabels(def.lookupApiId)[f];
            return (
              <span key={f} className="lookup-field" title={f}>
                <span className="muted">{label ?? f}:</span> {String(info[f] ?? "-")}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DEPENDENT_COMBO — 의존값(환경변수/기본입력/이전 조회 결과)으로 목록을 조회해
// 콤보로 선택한다. labelField=표현값, valueField=실제값.
// ---------------------------------------------------------------------------
function DependentComboInput({
  def,
  value,
  values,
  env,
  onChange,
}: {
  def: Extract<StepInputDef, { kind: "DEPENDENT_COMBO" }>;
  value: Primitive | undefined;
  values: Record<string, Primitive>;
  env?: EnvironmentValues;
  onChange: (key: string, value: Primitive) => void;
}) {
  const { lookupList } = useApiCombo();
  const dependValue = values[def.dependsOnKey] ?? env?.[def.dependsOnKey] ?? null;
  const [options, setOptions] = useState<{ label: string; value: string }[] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [failReason, setFailReason] = useState<string | null>(null);

  useEffect(() => {
    if (dependValue == null || dependValue === "") {
      setOptions(null);
      setStatus("idle");
      setFailReason(null);
      if (value != null) onChange(def.key, null);
      return;
    }
    let alive = true;
    setStatus("loading");
    setOptions(null);
    setFailReason(null);
    const t = setTimeout(() => {
      lookupList(def.lookupApiId, def.dependsOnKey, dependValue, def.labelField, def.valueField)
        .then((opts) => {
          if (!alive) return;
          setOptions(opts);
          setStatus(opts.length ? "ok" : "fail");
          if (!opts.length) setFailReason("조회 결과가 없습니다");
          // 선택값이 새 옵션에 없으면 초기화
          if (value != null && !opts.some((o) => o.value === String(value))) onChange(def.key, null);
        })
        .catch((e) => {
          if (!alive) return;
          setStatus("fail");
          setFailReason((e as Error).message);
          setOptions([]);
          onChange(def.key, null);
        });
    }, 400); // debounce
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // 의존값 변경 시에만 재조회
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependValue, def.lookupApiId, def.dependsOnKey, def.labelField, def.valueField, def.key]);

  if (dependValue == null || dependValue === "")
    return (
      <span className="hint">
        <code>{def.dependsOnKey}</code> 입력 후 목록이 채워집니다.
      </span>
    );
  if (status === "loading") return <span className="hint">목록 조회 중…</span>;
  if (status === "fail")
    return (
      <span className="hint error-text">
        조회 실패{failReason ? ` — ${failReason}` : ""}
      </span>
    );

  return (
    <select value={value == null ? "" : String(value)} onChange={(e) => onChange(def.key, e.target.value)}>
      <option value="" disabled>
        선택…
      </option>
      {(options ?? []).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label !== o.value ? `${o.label} (${o.value})` : o.label}
        </option>
      ))}
    </select>
  );
}
