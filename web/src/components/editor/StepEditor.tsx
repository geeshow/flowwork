import { useMemo, useState } from "react";

import type { WorkflowSummary } from "../../api/client";
import { colorForDomain } from "../../domainPalette";
import { refKey } from "../../engine/catalogLookup";
import type { CatalogEntry, StepApiBinding, StepResultView, ValueSource, WorkflowStep } from "../../types";
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
  domainColors: Record<string, string>;
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
  domainColors,
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

  // 다른 업무를 연결한 스텝이면, 연결된 워크플로우의 도메인 색으로 테두리·불릿을 칠한다.
  const linkedWf = step.workflowBinding
    ? workflows.find((w) => w.id === step.workflowBinding!.ref.id)
    : undefined;
  const linkColor = linkedWf ? colorForDomain(linkedWf.domain.normalize("NFC"), domainColors) : null;

  const selectedEntry = useMemo(
    () => entries.find((e) => refKey(e) === refKey(apiBinding.catalogEntry)) ?? null,
    [entries, apiBinding.catalogEntry],
  );

  // API의 모든 변수를 매핑 대상으로 나열한다 (환경변수 포함 — 사용자가 소스를 선택).
  const bindableVars = useMemo(() => selectedEntry?.variables ?? [], [selectedEntry]);

  // 결과 표시(원본/표 + 컬럼)
  const rv: StepResultView = step.resultView ?? { mode: "RAW", columns: [] };
  const setRv = (patch: Partial<StepResultView>) =>
    onChange({ ...step, resultView: { ...rv, ...patch } });
  const outFields = selectedEntry?.outputFields ?? [];
  const customCols = rv.columns.filter((c) => !outFields.includes(c));
  const [colText, setColText] = useState("");
  const addCol = () => {
    const c = colText.trim();
    if (c && !rv.columns.includes(c)) setRv({ columns: [...rv.columns, c] });
    setColText("");
  };

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
    <div
      className={`step-editor ${linkColor ? "linked" : ""}`}
      style={linkColor ? { borderColor: linkColor, borderLeftColor: linkColor } : undefined}
    >
      <div className="step-editor-head">
        <span className="step-order">{index + 1}</span>
        <span className="step-title">
          {linkColor ? <span className="task-bullet" style={{ background: linkColor }} /> : null}
          {step.name || <span className="muted">새 스텝</span>}
        </span>
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

      {mode === "API" ? (
        <div className="step-section">
          <h4>결과 표시</h4>
          <div className="mode-toggle">
            <button className={rv.mode === "RAW" ? "active" : ""} onClick={() => setRv({ mode: "RAW" })}>
              원본(JSON)
            </button>
            <button className={rv.mode === "TABLE" ? "active" : ""} onClick={() => setRv({ mode: "TABLE" })}>
              표
            </button>
          </div>

          {rv.mode === "TABLE" ? (
            <div className="result-cols">
              {outFields.length ? (
                <div className="checkbox-row">
                  {outFields.map((f) => {
                    const on = rv.columns.includes(f);
                    return (
                      <label key={f} className={`checkbox-chip ${on ? "on" : ""}`}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setRv({
                              columns: e.target.checked
                                ? [...rv.columns, f]
                                : rv.columns.filter((x) => x !== f),
                            })
                          }
                        />
                        {f}
                      </label>
                    );
                  })}
                </div>
              ) : null}

              {customCols.length ? (
                <div className="checkbox-row">
                  {customCols.map((c) => (
                    <span key={c} className="col-chip">
                      {c}
                      <button className="chip-x" onClick={() => setRv({ columns: rv.columns.filter((x) => x !== c) })}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="col-add">
                <input
                  placeholder="중첩 필드 추가 (예: owner.name)"
                  value={colText}
                  onChange={(e) => setColText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCol();
                    }
                  }}
                />
                <button className="link small" onClick={addCol}>
                  + 추가
                </button>
              </div>
              <p className="hint">
                비우면 전체 필드 자동 · 응답이 배열이면 각 행, 객체면 필드/값 표. 점 표기로 중첩 값을 지정합니다.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

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
