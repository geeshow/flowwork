import type { CatalogEntry, StepInputDef } from "../../types";
import { CatalogPicker } from "./CatalogPicker";

interface Props {
  inputs: StepInputDef[];
  entries: CatalogEntry[];
  onChange: (inputs: StepInputDef[]) => void;
}

type InputKind = StepInputDef["kind"];

function blankInput(kind: InputKind, key: string, label: string): StepInputDef {
  switch (kind) {
    case "MANUAL":
      return { kind, key, label, valueType: "string" };
    case "FIXED_COMBO":
      return { kind, key, label, options: [{ label: "", value: "" }] };
    case "API_COMBO":
      return { kind, key, label, sourceApiId: "", labelField: "", valueField: "" };
    case "DEPENDENT_LOOKUP":
      return { kind, key, label, dependsOnKey: "", lookupApiId: "", displayFields: [] };
  }
}

/** 입력값 정의(4종) 편집 — key/label + kind별 세부 필드. */
export function InputDefEditor({ inputs, entries, onChange }: Props) {
  const update = (i: number, patch: Partial<StepInputDef>) =>
    onChange(inputs.map((inp, idx) => (idx === i ? ({ ...inp, ...patch } as StepInputDef) : inp)));

  const changeKind = (i: number, kind: InputKind) =>
    onChange(inputs.map((inp, idx) => (idx === i ? blankInput(kind, inp.key, inp.label) : inp)));

  return (
    <div className="def-list">
      {inputs.map((inp, i) => (
        <div key={i} className="def-row">
          <div className="def-main">
            <input
              className="def-key"
              placeholder="key (예: customerId)"
              value={inp.key}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            <input
              className="def-label"
              placeholder="라벨 (예: 고객 ID)"
              value={inp.label}
              onChange={(e) => update(i, { label: e.target.value })}
            />
            <select value={inp.kind} onChange={(e) => changeKind(i, e.target.value as InputKind)}>
              <option value="MANUAL">직접 입력</option>
              <option value="FIXED_COMBO">고정값 콤보</option>
              <option value="API_COMBO">API 콤보</option>
              <option value="DEPENDENT_LOOKUP">의존 조회</option>
            </select>
            <button className="icon-btn" title="삭제" onClick={() => onChange(inputs.filter((_, idx) => idx !== i))}>
              ✕
            </button>
          </div>

          <KindFields input={inp} entries={entries} onPatch={(patch) => update(i, patch)} />
        </div>
      ))}

      <button
        className="link"
        onClick={() => onChange([...inputs, blankInput("MANUAL", "", "")])}
      >
        + 입력값 추가
      </button>
    </div>
  );
}

function KindFields({
  input,
  entries,
  onPatch,
}: {
  input: StepInputDef;
  entries: CatalogEntry[];
  onPatch: (patch: Partial<StepInputDef>) => void;
}) {
  switch (input.kind) {
    case "MANUAL":
      return (
        <div className="def-sub">
          <label>
            타입
            <select
              value={input.valueType}
              onChange={(e) => onPatch({ valueType: e.target.value as "string" | "number" })}
            >
              <option value="string">문자열</option>
              <option value="number">숫자</option>
            </select>
          </label>
        </div>
      );

    case "FIXED_COMBO":
      return (
        <div className="def-sub">
          {input.options.map((o, j) => (
            <div key={j} className="combo-opt">
              <input
                placeholder="라벨"
                value={o.label}
                onChange={(e) =>
                  onPatch({
                    options: input.options.map((x, k) => (k === j ? { ...x, label: e.target.value } : x)),
                  })
                }
              />
              <input
                placeholder="값"
                value={o.value}
                onChange={(e) =>
                  onPatch({
                    options: input.options.map((x, k) => (k === j ? { ...x, value: e.target.value } : x)),
                  })
                }
              />
              <button
                className="icon-btn"
                onClick={() => onPatch({ options: input.options.filter((_, k) => k !== j) })}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            className="link small"
            onClick={() => onPatch({ options: [...input.options, { label: "", value: "" }] })}
          >
            + 옵션
          </button>
        </div>
      );

    case "API_COMBO":
      return (
        <div className="def-sub def-col">
          <div className="def-field">
            <span className="def-field-label">소스 API</span>
            <CatalogPicker
              entries={entries}
              selectedId={input.sourceApiId || null}
              onSelect={(e) => onPatch({ sourceApiId: e.id })}
            />
          </div>
          <div className="grid2">
            <input placeholder="labelField (예: name)" value={input.labelField} onChange={(e) => onPatch({ labelField: e.target.value })} />
            <input placeholder="valueField (예: id)" value={input.valueField} onChange={(e) => onPatch({ valueField: e.target.value })} />
          </div>
        </div>
      );

    case "DEPENDENT_LOOKUP":
      return (
        <div className="def-sub def-col">
          <div className="grid2">
            <input placeholder="dependsOnKey (의존 입력 key)" value={input.dependsOnKey} onChange={(e) => onPatch({ dependsOnKey: e.target.value })} />
            <input
              placeholder="displayFields (콤마, 예: name,phone)"
              value={input.displayFields.join(",")}
              onChange={(e) => onPatch({ displayFields: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
          </div>
          <div className="def-field">
            <span className="def-field-label">조회 API (변수명 = dependsOnKey)</span>
            <CatalogPicker
              entries={entries}
              selectedId={input.lookupApiId || null}
              onSelect={(e) => onPatch({ lookupApiId: e.id })}
            />
          </div>
        </div>
      );
  }
}
