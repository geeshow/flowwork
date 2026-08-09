import { useMemo } from "react";

import type { WorkflowSummary } from "../../api/client";
import { refKey } from "../../engine/catalogLookup";
import type { CatalogEntry, StepApiBinding, ValueSource, WorkflowStep } from "../../types";
import { BranchConditionEditor } from "./BranchConditionEditor";
import { CatalogPicker } from "./CatalogPicker";
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

  // API의 모든 변수를 매핑 대상으로 나열한다 (환경변수 포함 — 사용자가 소스를 선택).
  const bindableVars = useMemo(() => selectedEntry?.variables ?? [], [selectedEntry]);

  const setMode = (next: "API" | "WORKFLOW") => {
    if (next === mode) return;
    if (next === "WORKFLOW") {
      onChange({
        ...step,
        name: "",
        apiBinding: undefined,
        workflowBinding: { ref: { id: "" }, inputMappings: {} },
      });
    } else {
      onChange({ ...step, name: "", workflowBinding: undefined, apiBinding: EMPTY_API_BINDING });
    }
  };

  const onSelectEntry = (entry: CatalogEntry) => {
    // 기존 바인딩 유지 + 변수명이 환경변수 key와 같으면 ENV로 기본값 채움
    const kept: Record<string, ValueSource> = {};
    for (const v of entry.variables) {
      if (apiBinding.variableBindings[v]) kept[v] = apiBinding.variableBindings[v];
      else if (envKeys.has(v)) kept[v] = { kind: "ENV", envKey: v };
    }
    onChange({
      ...step,
      name: entry.name, // 스텝 이름 = 선택한 API 이름 (자동)
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

  const onLinkChange = (workflowBinding: WorkflowStep["workflowBinding"]) => {
    // 스텝 이름 = 연결한 업무 이름 (자동)
    const linked = workflows.find((w) => w.id === workflowBinding?.ref.id);
    onChange({ ...step, workflowBinding, name: linked?.name ?? "" });
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
        <span className="step-title">{step.name || <span className="muted">새 스텝</span>}</span>
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
                  envKeys={[...envKeys]}
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
            envKeys={[...envKeys]}
            prevStepIds={prevSteps}
            onChange={onLinkChange}
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
