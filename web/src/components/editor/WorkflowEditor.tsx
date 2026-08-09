import { useEffect, useMemo, useState } from "react";

import { api } from "../../api/client";
import type { CatalogEntry, EnvironmentValues, Workflow, WorkflowStep } from "../../types";
import { StepEditor } from "./StepEditor";

interface Props {
  mode: "new" | "edit";
  group?: string;
  id?: string;
  onSaved: (group: string, id: string) => void;
  onCancel: () => void;
}

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function emptyWorkflow(): Workflow {
  return { id: "", group: "", name: "", description: "", steps: [] };
}

function newStep(): WorkflowStep {
  return {
    id: `step_${Math.random().toString(36).slice(2, 8)}`,
    order: 0,
    name: "조회",
    inputs: [],
    apiBinding: {
      catalogEntry: { department: "", collectionFile: "", itemPath: [], name: "" },
      variableBindings: {},
    },
  };
}

export function WorkflowEditor({ mode, group, id, onSaved, onCancel }: Props) {
  const [wf, setWf] = useState<Workflow | null>(mode === "new" ? emptyWorkflow() : null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [env, setEnv] = useState<EnvironmentValues>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.searchCatalog(""), api.getEnvironments()])
      .then(([cat, envs]) => {
        if (!alive) return;
        setEntries(cat.results);
        setEnv(envs);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !group || !id) return;
    let alive = true;
    api
      .getWorkflow(group, id)
      .then((w) => alive && setWf(w))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [mode, group, id]);

  const envKeys = useMemo(() => new Set(Object.keys(env)), [env]);
  const inputKeys = useMemo(
    () => (wf ? [...new Set(wf.steps.flatMap((s) => s.inputs.map((i) => i.key).filter(Boolean)))] : []),
    [wf],
  );

  if (error) return <div className="error-banner">{error}</div>;
  if (!wf) return <p className="muted">불러오는 중…</p>;

  const patch = (p: Partial<Workflow>) => setWf({ ...wf, ...p });

  const updateStep = (i: number, step: WorkflowStep) =>
    setWf({ ...wf, steps: wf.steps.map((s, idx) => (idx === i ? step : s)) });

  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= wf.steps.length) return;
    const next = [...wf.steps];
    [next[i], next[j]] = [next[j], next[i]];
    setWf({ ...wf, steps: next });
  };

  function validate(w: Workflow): string | null {
    if (!SAFE_SEGMENT.test(w.group)) return "그룹은 영문/숫자/-/_ 만 사용할 수 있습니다.";
    if (!SAFE_SEGMENT.test(w.id)) return "ID는 영문/숫자/-/_ 만 사용할 수 있습니다.";
    if (!w.name.trim()) return "이름을 입력하세요.";
    for (const [idx, s] of w.steps.entries()) {
      if (!s.apiBinding.catalogEntry.name) return `${idx + 1}번 스텝: 처리 API를 선택하세요.`;
    }
    return null;
  }

  async function handleSave() {
    const normalized: Workflow = {
      ...wf!,
      steps: wf!.steps.map((s, idx) => ({ ...s, order: idx + 1 })),
    };
    const problem = validate(normalized);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.saveWorkflow(normalized);
      onSaved(normalized.group, normalized.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="editor">
      <div className="editor-head">
        <h2>{mode === "new" ? "새 워크플로우" : "워크플로우 편집"}</h2>
        <div className="editor-actions">
          <button className="link" onClick={onCancel}>
            취소
          </button>
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>

      <section className="panel">
        <h3>기본 정보</h3>
        <div className="meta-grid">
          <label className="field">
            <span className="field-label">그룹 <code className="field-key">group</code></span>
            <input
              value={wf.group}
              disabled={mode === "edit"}
              placeholder="payments"
              onChange={(e) => patch({ group: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">ID <code className="field-key">id</code></span>
            <input
              value={wf.id}
              disabled={mode === "edit"}
              placeholder="wf_settlement_cancel"
              onChange={(e) => patch({ id: e.target.value })}
            />
          </label>
          <label className="field wide">
            <span className="field-label">이름</span>
            <input value={wf.name} placeholder="정산 취소 처리" onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="field wide">
            <span className="field-label">설명</span>
            <input
              value={wf.description ?? ""}
              placeholder="고객 정산을 조회하고, 상태가 ACTIVE면 취소한다."
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>스텝 ({wf.steps.length})</h3>
          <button className="link" onClick={() => setWf({ ...wf, steps: [...wf.steps, newStep()] })}>
            + 스텝 추가
          </button>
        </div>

        {wf.steps.length === 0 ? (
          <p className="muted">스텝이 없습니다. "스텝 추가"로 세부 기능(조회/등록/폐쇄/수정)을 등록하세요.</p>
        ) : null}

        <div className="step-editor-list">
          {wf.steps.map((step, i) => (
            <StepEditor
              key={step.id}
              step={step}
              index={i}
              total={wf.steps.length}
              entries={entries}
              envKeys={envKeys}
              inputKeys={inputKeys}
              prevSteps={wf.steps.slice(0, i).map((s) => ({ id: s.id, label: `${s.name} (${s.id})` }))}
              onChange={(s) => updateStep(i, s)}
              onRemove={() => setWf({ ...wf, steps: wf.steps.filter((_, idx) => idx !== i) })}
              onMove={(dir) => moveStep(i, dir)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
