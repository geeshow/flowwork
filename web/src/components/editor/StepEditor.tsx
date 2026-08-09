import { useMemo } from "react";

import { refKey } from "../../engine/catalogLookup";
import type { CatalogEntry, ValueSource, WorkflowStep } from "../../types";
import { BranchConditionEditor } from "./BranchConditionEditor";
import { CatalogPicker } from "./CatalogPicker";
import { InputDefEditor } from "./InputDefEditor";
import { VariableBindingEditor } from "./VariableBindingEditor";

interface Props {
  step: WorkflowStep;
  index: number;
  total: number;
  entries: CatalogEntry[];
  envKeys: Set<string>;
  inputKeys: string[];
  prevSteps: { id: string; label: string }[];
  onChange: (step: WorkflowStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

const STEP_NAMES = ["조회", "등록", "폐쇄", "수정"];

export function StepEditor({
  step,
  index,
  total,
  entries,
  envKeys,
  inputKeys,
  prevSteps,
  onChange,
  onRemove,
  onMove,
}: Props) {
  const selectedEntry = useMemo(
    () => entries.find((e) => refKey(e) === refKey(step.apiBinding.catalogEntry)) ?? null,
    [entries, step.apiBinding.catalogEntry],
  );

  // 바인딩이 필요한 변수 = 카탈로그 변수 − 환경변수
  const bindableVars = useMemo(
    () => (selectedEntry?.variables ?? []).filter((v) => !envKeys.has(v)),
    [selectedEntry, envKeys],
  );

  const onSelectEntry = (entry: CatalogEntry) => {
    const vars = entry.variables.filter((v) => !envKeys.has(v));
    const kept: Record<string, ValueSource> = {};
    for (const v of vars) {
      if (step.apiBinding.variableBindings[v]) kept[v] = step.apiBinding.variableBindings[v];
    }
    onChange({
      ...step,
      apiBinding: {
        ...step.apiBinding,
        catalogEntry: {
          department: entry.department,
          collectionFile: entry.collectionFile,
          itemPath: entry.itemPath,
          name: entry.name,
        },
        variableBindings: kept,
      },
    });
  };

  const setBinding = (variable: string, source: ValueSource) =>
    onChange({
      ...step,
      apiBinding: {
        ...step.apiBinding,
        variableBindings: { ...step.apiBinding.variableBindings, [variable]: source },
      },
    });

  return (
    <div className="step-editor">
      <div className="step-editor-head">
        <span className="step-order">{index + 1}</span>
        <select value={step.name} onChange={(e) => onChange({ ...step, name: e.target.value })}>
          {STEP_NAMES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          {STEP_NAMES.includes(step.name) ? null : <option value={step.name}>{step.name}</option>}
        </select>
        <span className="step-id muted">{step.id}</span>
        <div className="step-actions">
          <button className="icon-btn" disabled={index === 0} onClick={() => onMove(-1)} title="위로">
            ↑
          </button>
          <button className="icon-btn" disabled={index === total - 1} onClick={() => onMove(1)} title="아래로">
            ↓
          </button>
          <button className="icon-btn danger" onClick={onRemove} title="스텝 삭제">
            ✕
          </button>
        </div>
      </div>

      <div className="step-section">
        <h4>입력값 정의</h4>
        <InputDefEditor
          inputs={step.inputs}
          entries={entries}
          onChange={(inputs) => onChange({ ...step, inputs })}
        />
      </div>

      <div className="step-section">
        <h4>처리 API</h4>
        <CatalogPicker entries={entries} selectedId={selectedEntry?.id ?? null} onSelect={onSelectEntry} />
        {selectedEntry ? (
          <div className="binding-block">
            <h5>변수 바인딩</h5>
            <VariableBindingEditor
              variables={bindableVars}
              bindings={step.apiBinding.variableBindings}
              inputKeys={inputKeys}
              prevStepIds={prevSteps}
              onChange={setBinding}
            />
          </div>
        ) : null}
      </div>

      <div className="step-section">
        <h4>분기 조건</h4>
        <BranchConditionEditor
          condition={step.branchCondition}
          prevStepIds={prevSteps}
          onChange={(branchCondition) => onChange({ ...step, branchCondition })}
        />
      </div>

      <label className="stop-toggle">
        <input
          type="checkbox"
          checked={!!step.stopOnFailure}
          onChange={(e) => onChange({ ...step, stopOnFailure: e.target.checked })}
        />
        실패 시 이후 스텝 중단 (stopOnFailure)
      </label>
    </div>
  );
}
