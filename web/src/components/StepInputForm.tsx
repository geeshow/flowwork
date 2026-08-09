import { useEffect, useState } from "react";

import type { Primitive, StepInputDef } from "../types";
import { useApiCombo } from "./ApiComboProvider";

interface Props {
  inputs: StepInputDef[];
  values: Record<string, Primitive>;
  onChange: (key: string, value: Primitive) => void;
}

/**
 * 입력 폼 — StepInputDef.kind에 따라 분기 렌더링하되, 부모에게는 동일 인터페이스
 * (values, onChange)로 노출한다. 폼의 최종 결과값이 곧 실행 엔진의
 * ExecutionContext.userInputs가 된다.
 */
export function StepInputForm({ inputs, values, onChange }: Props) {
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
          <InputControl def={def} values={values} onChange={onChange} />
        </label>
      ))}
    </div>
  );
}

function InputControl({
  def,
  values,
  onChange,
}: {
  def: StepInputDef;
  values: Record<string, Primitive>;
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
          type={def.valueType === "number" ? "number" : "text"}
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
      return <DependentLookupInput def={def} value={values[def.key]} values={values} onChange={onChange} />;
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
  onChange,
}: {
  def: Extract<StepInputDef, { kind: "DEPENDENT_LOOKUP" }>;
  value: Primitive | undefined;
  values: Record<string, Primitive>;
  onChange: (key: string, value: Primitive) => void;
}) {
  const { lookup } = useApiCombo();
  const dependValue = values[def.dependsOnKey];
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");

  useEffect(() => {
    if (dependValue == null || dependValue === "") {
      setInfo(null);
      setStatus("idle");
      if (value != null) onChange(def.key, null);
      return;
    }
    let alive = true;
    setStatus("loading");
    const t = setTimeout(() => {
      lookup(def.lookupApiId, def.dependsOnKey, dependValue)
        .then((row) => {
          if (!alive) return;
          if (row) {
            setInfo(row);
            setStatus("ok");
            onChange(def.key, dependValue); // 조회 성공 시 값 자동 확정
          } else {
            setInfo(null);
            setStatus("fail");
            onChange(def.key, null);
          }
        })
        .catch(() => {
          if (alive) {
            setStatus("fail");
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
        {status === "ok" ? <span className="hint ok-text"> ✓ 확정</span> : null}
        {status === "fail" ? <span className="hint error-text"> 조회 실패</span> : null}
      </div>
      {status === "ok" && info ? (
        <div className="lookup-info">
          {def.displayFields.map((f) => (
            <span key={f} className="lookup-field">
              <span className="muted">{f}:</span> {String(info[f] ?? "-")}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
