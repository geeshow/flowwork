import { useEffect, useMemo, useState } from "react";

import { api, type WorkflowSummary } from "../../api/client";
import type { CatalogEntry, EnvironmentValues, Workflow, WorkflowStep } from "../../types";
import { InputDefEditor } from "./InputDefEditor";
import { StepEditor } from "./StepEditor";

interface Props {
  mode: "new" | "edit";
  id?: string;
  initialDomain?: string; // 새 워크플로우 시 기본 도메인 (현재 보던 도메인 탭)
  onSaved: (id: string) => void;
  onCancel: () => void;
}

// 도메인/업무는 파일 경로 세그먼트이므로 단어문자 + 한글 + 하이픈만 허용
const SAFE_SEGMENT = /^[\w가-힣-]+$/;

function emptyWorkflow(domain = ""): Workflow {
  return {
    id: crypto.randomUUID(),
    domain,
    task: "",
    name: "",
    description: "",
    baseInputs: [],
    steps: [],
  };
}

function newStep(): WorkflowStep {
  return {
    id: `step_${Math.random().toString(36).slice(2, 8)}`,
    order: 0,
    name: "", // API/업무를 선택하면 그 이름으로 자동 설정
    apiBinding: {
      catalogEntry: { department: "", collectionFile: "", itemPath: [], name: "" },
      variableBindings: {},
    },
  };
}

export function WorkflowEditor({ mode, id, initialDomain, onSaved, onCancel }: Props) {
  const [wf, setWf] = useState<Workflow | null>(mode === "new" ? emptyWorkflow(initialDomain) : null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [env, setEnv] = useState<EnvironmentValues>({});
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.searchCatalog(""), api.getEnvironments(), api.listWorkflows()])
      .then(([cat, envs, wfs]) => {
        if (!alive) return;
        setEntries(cat.results);
        setEnv(envs);
        setWorkflows(wfs);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    let alive = true;
    api
      .getWorkflow(id)
      .then((w) => alive && setWf(w))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [mode, id]);

  const envKeys = useMemo(() => new Set(Object.keys(env)), [env]);
  const inputKeys = useMemo(
    () => (wf ? wf.baseInputs.map((i) => i.key).filter(Boolean) : []),
    [wf],
  );

  const domainOptions = useMemo(
    () => [...new Set(workflows.map((w) => w.domain))].sort((a, b) => a.localeCompare(b, "ko")),
    [workflows],
  );
  const taskOptions = useMemo(
    () =>
      [...new Set(workflows.filter((w) => !wf || w.domain === wf.domain).map((w) => w.task))].sort(
        (a, b) => a.localeCompare(b, "ko"),
      ),
    [workflows, wf],
  );

  if (error && !wf) return <div className="error-banner">{error}</div>;
  if (!wf) return <p className="muted">불러오는 중…</p>;

  const identityReady = !!wf.domain.trim() && !!wf.task.trim() && !!wf.name.trim();

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
    if (!SAFE_SEGMENT.test(w.domain)) return "도메인은 영문/숫자/한글/-/_ 만 사용할 수 있습니다.";
    if (!SAFE_SEGMENT.test(w.task)) return "업무는 영문/숫자/한글/-/_ 만 사용할 수 있습니다.";
    if (!w.name.trim()) return "이름을 입력하세요.";
    // (도메인, 업무) 내 이름 중복 사전 검사 (서버도 409로 최종 검증)
    const dup = workflows.some(
      (x) => x.id !== w.id && x.domain === w.domain && x.task === w.task && x.name === w.name.trim(),
    );
    if (dup) return `'${w.domain}/${w.task}'에 이미 '${w.name}' 이름이 있습니다.`;
    for (const [idx, s] of w.steps.entries()) {
      if (s.workflowBinding) {
        if (!s.workflowBinding.ref.id) return `${idx + 1}번 스텝: 연결할 업무를 선택하세요.`;
      } else if (s.apiBinding) {
        if (!s.apiBinding.catalogEntry.name) return `${idx + 1}번 스텝: 처리 API를 선택하세요.`;
      } else {
        return `${idx + 1}번 스텝: 처리 방식(API 또는 업무 연결)을 설정하세요.`;
      }
    }
    return null;
  }

  async function handleSave() {
    const normalized: Workflow = {
      ...wf!,
      name: wf!.name.trim(),
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
      onSaved(normalized.id);
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

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="panel">
        <h3>기본 정보</h3>
        <div className="meta-grid">
          <label className="field">
            <span className="field-label">도메인</span>
            <input
              list="domain-options"
              value={wf.domain}
              placeholder="예: 계좌 (선택 또는 입력)"
              onChange={(e) => patch({ domain: e.target.value })}
            />
            <datalist id="domain-options">
              {domainOptions.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span className="field-label">업무</span>
            <input
              list="task-options"
              value={wf.task}
              placeholder="예: 계좌개설 (선택 또는 입력)"
              onChange={(e) => patch({ task: e.target.value })}
            />
            <datalist id="task-options">
              {taskOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <label className="field wide">
            <span className="field-label">이름 <span className="hint">(도메인·업무 내에서 유일)</span></span>
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
          <h3>환경 변수 <span className="hint">({Object.keys(env).length}개 · 읽기 전용)</span></h3>
          <button className="link" onClick={() => setEnvOpen((v) => !v)}>
            {envOpen ? "접기" : "보기"}
          </button>
        </div>
        {envOpen ? (
          Object.keys(env).length === 0 ? (
            <p className="muted">환경 변수가 없습니다.</p>
          ) : (
            <div className="env-list">
              {Object.entries(env).map(([k, v]) => (
                <div key={k} className="env-row">
                  <code className="env-key">{k}</code>
                  <code className="env-val">{v}</code>
                </div>
              ))}
            </div>
          )
        ) : null}
      </section>

      <section className="panel">
        <h3>기본 입력값 <span className="hint">(스텝보다 먼저 정의)</span></h3>
        <InputDefEditor
          inputs={wf.baseInputs}
          entries={entries}
          onChange={(baseInputs) => patch({ baseInputs })}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>스텝 ({wf.steps.length})</h3>
          <button
            className="link"
            disabled={!identityReady}
            onClick={() => setWf({ ...wf, steps: [...wf.steps, newStep()] })}
          >
            + 스텝 추가
          </button>
        </div>

        {!identityReady ? (
          <p className="muted">먼저 도메인·업무·이름을 입력하면 스텝을 추가할 수 있습니다.</p>
        ) : wf.steps.length === 0 ? (
          <p className="muted">스텝이 없습니다. "스텝 추가"로 API를 선택하고 입력을 매핑하세요.</p>
        ) : null}

        <div className="step-editor-list">
          {wf.steps.map((step, i) => (
            <StepEditor
              key={step.id}
              step={step}
              index={i}
              total={wf.steps.length}
              entries={entries}
              workflows={workflows}
              selfId={wf.id}
              envKeys={envKeys}
              inputKeys={inputKeys}
              prevSteps={wf.steps.slice(0, i).map((s, si) => ({ id: s.id, label: `${si + 1}. ${s.name || "스텝"}` }))}
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
