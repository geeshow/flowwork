import type { BranchCondition, BranchOperator } from "../../types";

interface Props {
  condition: BranchCondition | undefined;
  prevStepIds: { id: string; label: string }[];
  onChange: (condition: BranchCondition | undefined) => void;
}

const OPERATORS: { value: BranchOperator; label: string; needsValue: boolean }[] = [
  { value: "EQ", label: "= (같음)", needsValue: true },
  { value: "NE", label: "≠ (다름)", needsValue: true },
  { value: "GT", label: "> (초과)", needsValue: true },
  { value: "LT", label: "< (미만)", needsValue: true },
  { value: "EXISTS", label: "존재함", needsValue: false },
  { value: "CONTAINS", label: "포함", needsValue: true },
];

/** 분기 조건 — 없으면 항상 실행, 있으면 이전 스텝 응답으로 스킵 여부 결정. */
export function BranchConditionEditor({ condition, prevStepIds, onChange }: Props) {
  if (!condition) {
    return (
      <div>
        <p className="muted">분기 조건 없음 — 항상 실행됩니다.</p>
        <button
          className="link"
          disabled={prevStepIds.length === 0}
          onClick={() => onChange({ sourceStepId: "", jsonPath: "$.", operator: "EQ", compareValue: "" })}
        >
          + 분기 조건 추가
        </button>
        {prevStepIds.length === 0 ? <span className="hint"> (이전 스텝이 있어야 추가 가능)</span> : null}
      </div>
    );
  }

  const op = OPERATORS.find((o) => o.value === condition.operator);

  const set = (patch: Partial<BranchCondition>) => onChange({ ...condition, ...patch });

  return (
    <div className="branch-editor">
      <div className="branch-row">
        <select value={condition.sourceStepId} onChange={(e) => set({ sourceStepId: e.target.value })}>
          <option value="" disabled>
            소스 스텝…
          </option>
          {prevStepIds.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          placeholder="$.data.status"
          value={condition.jsonPath}
          onChange={(e) => set({ jsonPath: e.target.value })}
        />
        <select value={condition.operator} onChange={(e) => set({ operator: e.target.value as BranchOperator })}>
          {OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {op?.needsValue ? (
          <input
            placeholder="비교값"
            value={condition.compareValue == null ? "" : String(condition.compareValue)}
            onChange={(e) => set({ compareValue: e.target.value })}
          />
        ) : null}
      </div>
      <button className="link small" onClick={() => onChange(undefined)}>
        분기 조건 제거
      </button>
    </div>
  );
}
