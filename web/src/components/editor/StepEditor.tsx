import { useMemo } from "react";

import type { WorkflowSummary } from "../../api/client";
import { refKey } from "../../engine/catalogLookup";
import type { CatalogEntry, StepApiBinding, ValueSource, WorkflowStep } from "../../types";
import { BranchConditionEditor } from "./BranchConditionEditor";
import { CatalogPicker } from "./CatalogPicker";
import { InputDefEditor } from "./InputDefEditor";
import { VariableBindingEditor } from "./VariableBindingEditor";
import { WorkflowLinkEditor } from "./WorkflowLinkEditor";

interface Props {
  step: WorkflowStep;
  index: number;
  total: number;
  entries: CatalogEntry[];
  workflows: WorkflowSummary[];
  selfId: string;
  envKeys: Set<string>;
  inputKeys: string[];
  prevSteps: { id: string; label: string }[];
  onChange: (step: WorkflowStep) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

const STEP_NAMES = ["조회", "등록", "폐쇄", "수정"];

const EMPTY_API_BINDING: StepApiBinding = {
  catalogEntry: { department: "", collectionFile: "", itemPath: [], name: "" },
  variableBindings: {},
};

export function StepEditor({
  step,
  index,
  total,
  entries,
  workflows,
  selfId,
  envKeys,
  inputKeys,
  prevSteps,
  onChange,
  onRemove,
  onMove,
}: Props) {
  const mode: "API" | "WORKFLOW" = step.workflowBinding ? "WORKFLOW" : "API";
  const apiBinding = step.apiBinding ?? EMPTY_API_BINDING;

  const selectedEntry = useMemo(
    () => entries.find((e) => refKey(e) === refKey(apiBinding.catalogEntry)) ?? null,
    [entries, apiBinding.catalogEntry],
  );

  // 바인딩이 필요한 변수 = 카탈로그 변수 − 환경변수
  const bindableVars = useMemo(
    () => (selectedEntry?.variables ?? []).filter((v) => !envKeys.has(v)),
    [selectedEntry, envKeys],
  );

  const setMode = (next: "API" | "WORKFLOW") => {
    if (next === mode) return;
    if (next === "WORKFLOW") {
      onChange({
        ...step,
        apiBinding: undefined,
        workflowBinding: { ref: { group: "", id: "" }, inputMappings: {} },
      });
    } else {
      onChange({ ...step, workflowBinding: undefined, apiBinding: EMPTY_API_BINDING });
    }
  };

  const onSelectEntry = (entry: CatalogEntry) => {
    const vars = entry.variables.filter((v) => !envKeys.has(v));
    const kept: Record<string, ValueSource> = {};
    for (const v of vars) {
      if (apiBinding.variableBindings[v]) kept[v] = apiBinding.variableBindings[v];
    }
    onChange({
      ...step,
      apiBinding: {
        ...apiBinding,
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
        ...apiBinding,
        variableBindings: { ...apiBinding.variableBindings, [variable]: source },
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
        <div className="processing-head">
          <h4>처리 방식</h4>
          <div className="mode-toggle">
            <button className={mode === "API" ? "active" : ""} onClick={() => setMode("API")}>
              API 호출
            </button>
            <button className={mode === "WORKFLOW" ? "active" : ""} onClick={() => setMode("WORKFLOW")}>
              다른 업무 연결
            </button>
          </div>
        </div>

        {mode === "API" ? (
          <>
            <CatalogPicker entries={entries} selectedId={selectedEntry?.id ?? null} onSelect={onSelectEntry} />
            {selectedEntry ? (
              <div className="binding-block">
                <h5>변수 바인딩</h5>
                <VariableBindingEditor
                  variables={bindableVars}
                  bindings={apiBinding.variableBindings}
                  inputKeys={inputKeys}
                  prevStepIds={prevSteps}
                  onChange={setBinding}
                />
              </div>
            ) : null}
          </>
        ) : (
          <WorkflowLinkEditor
            binding={step.workflowBinding!}
            workflows={workflows}
            selfId={selfId}
            inputKeys={inputKeys}
            prevStepIds={prevSteps}
            onChange={(workflowBinding) => onChange({ ...step, workflowBinding })}
          />
        )}
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
