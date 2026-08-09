import { useEffect, useMemo, useState } from "react";

import { api, type WorkflowSummary } from "../api/client";
import { colorForDomain } from "../domainPalette";
import { makeTemplateResolver } from "../engine/catalogLookup";
import { runWorkflow, type RunDeps } from "../engine/runWorkflow";
import type {
  CatalogEntry,
  EnvironmentValues,
  ExecutionResult,
  Primitive,
  StepExecutionState,
  Workflow,
} from "../types";
import { ApiComboProvider } from "./ApiComboProvider";
import { StepCard } from "./StepCard";
import { StepInputForm } from "./StepInputForm";

interface Props {
  workflow: Workflow;
  onOpenExecution: (executionId: string) => void;
}

export function WorkflowRunner({ workflow, onOpenExecution }: Props) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [env, setEnv] = useState<EnvironmentValues>({});
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [domainColors, setDomainColors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [values, setValues] = useState<Record<string, Primitive>>({});
  const [states, setStates] = useState<Map<string, StepExecutionState>>(new Map());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.searchCatalog(""), api.getEnvironments(), api.listWorkflows(), api.getDomainColors()])
      .then(([cat, envs, wfs, colors]) => {
        if (!alive) return;
        setCatalog(cat.results);
        setEnv(envs);
        setSummaries(wfs);
        setDomainColors(colors);
        setLoaded(true);
      })
      .catch((e) => alive && setLoadError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  // 기본 입력값(워크플로우 레벨)이 곧 실행 엔진의 userInputs가 된다
  const allInputs = workflow.baseInputs;

  const orderedSteps = useMemo(
    () => [...workflow.steps].sort((a, b) => a.order - b.order),
    [workflow],
  );

  // 다른 업무를 연결한 스텝 → 연결된 워크플로우의 도메인 색상
  const accentFor = (stepId: string): string | null => {
    const step = workflow.steps.find((s) => s.id === stepId);
    const linkId = step?.workflowBinding?.ref.id;
    if (!linkId) return null;
    const linked = summaries.find((w) => w.id === linkId);
    return linked ? colorForDomain(linked.domain.normalize("NFC"), domainColors) : null;
  };

  async function handleRun() {
    setRunning(true);
    setResult(null);
    setStates(new Map());

    const wfCache = new Map<string, Workflow>();
    const deps: RunDeps = {
      getRequestTemplate: makeTemplateResolver(catalog),
      proxy: api.proxy,
      env,
      // 다른 업무 연결 스텝: 내부 id로 하위 워크플로우 로드 (세션 내 캐시)
      getWorkflow: async (id) => {
        const cached = wfCache.get(id);
        if (cached) return cached;
        const wf = await api.getWorkflow(id);
        wfCache.set(id, wf);
        return wf;
      },
    };

    const onStepUpdate = (s: StepExecutionState) =>
      setStates((prev) => new Map(prev).set(s.stepId, s));

    try {
      const res = await runWorkflow(workflow, values, deps, onStepUpdate);
      setResult(res);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  if (!loaded) {
    return loadError ? (
      <div className="error-banner">{loadError}</div>
    ) : (
      <p className="muted">카탈로그 불러오는 중…</p>
    );
  }

  return (
    <ApiComboProvider entries={catalog} env={env}>
    <div className="runner">
      <header className="runner-head">
        <div>
          <span className="badge">{workflow.domain}</span>
          <span className="badge">{workflow.task}</span>
          <h2>{workflow.name}</h2>
          {workflow.description ? <p className="muted">{workflow.description}</p> : null}
        </div>
        <button className="primary" onClick={handleRun} disabled={running || !!loadError}>
          {running ? "실행 중…" : "실행"}
        </button>
      </header>

      {loadError ? <div className="error-banner">{loadError}</div> : null}

      <section className="panel">
        <h3>입력값</h3>
        <StepInputForm
          inputs={allInputs}
          values={values}
          onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
        />
      </section>

      <section className="panel">
        <h3>스텝</h3>
        <div className="step-list">
          {orderedSteps.map((step) => (
            <StepCard
              key={step.id}
              step={step}
              state={states.get(step.id)}
              accentColor={accentFor(step.id)}
            />
          ))}
        </div>
      </section>

      {result ? (
        <div className={`result-banner ${result.overallStatus.toLowerCase()}`}>
          <span>
            실행 완료 — <strong>{result.overallStatus}</strong>
          </span>
          <button className="link" onClick={() => onOpenExecution(result.executionId)}>
            실행 이력 열기 →
          </button>
        </div>
      ) : null}
    </div>
    </ApiComboProvider>
  );
}
