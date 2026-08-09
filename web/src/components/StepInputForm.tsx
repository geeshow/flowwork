import type { Primitive, StepInputDef } from "../types";

interface Props {
  inputs: StepInputDef[];
  values: Record<string, Primitive>;
  onChange: (key: string, value: Primitive) => void;
}

/**
 * 입력 폼 — StepInputDef.kind에 따라 분기 렌더링하되, 부모에게는 동일 인터페이스
 * (values, onChange)로 노출한다. 폼의 최종 결과값이 곧 실행 엔진의
 * ExecutionContext.userInputs가 된다.
 *
 * POC: MANUAL / FIXED_COMBO 완전 지원. API_COMBO / DEPENDENT_LOOKUP는 카탈로그
 * 조회 연동 전까지 값 직접 입력으로 대체(엔진 관점에선 동일하게 USER_INPUT).
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
          <InputControl def={def} value={values[def.key]} onChange={onChange} />
        </label>
      ))}
    </div>
  );
}

function InputControl({
  def,
  value,
  onChange,
}: {
  def: StepInputDef;
  value: Primitive | undefined;
  onChange: (key: string, value: Primitive) => void;
}) {
  switch (def.kind) {
    case "FIXED_COMBO":
      return (
        <select
          value={value == null ? "" : String(value)}
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
          value={value == null ? "" : String(value)}
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
    case "DEPENDENT_LOOKUP":
      return (
        <>
          <input
            type="text"
            value={value == null ? "" : String(value)}
            onChange={(e) => onChange(def.key, e.target.value)}
            placeholder="값 직접 입력"
          />
          <span className="hint">
            {def.kind === "API_COMBO" ? "API 콤보" : "의존 조회"} 연동 예정 — 현재는 직접 입력
          </span>
        </>
      );
  }
}
