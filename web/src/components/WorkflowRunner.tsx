import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import { makeTemplateResolver } from "../engine/catalogLookup";
import { runWorkflow, type RunDeps } from "../engine/runWorkflow";
import type {
  CatalogEntry,
  EnvironmentValues,
  ExecutionResult,
  Primitive,
  StepExecutionState,
  StepInputDef,
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [values, setValues] = useState<Record<string, Primitive>>({});
  const [states, setStates] = useState<Map<string, StepExecutionState>>(new Map());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecutionResult | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.searchCatalog(""), api.getEnvironments()])
      .then(([cat, envs]) => {
        if (!alive) return;
        setCatalog(cat.results);
        setEnv(envs);
        setLoaded(true);
      })
      .catch((e) => alive && setLoadError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  // 모든 스텝의 입력 정의를 key 기준으로 합쳐 하나의 폼으로 (userInputs는 워크플로우 공용)
  const allInputs = useMemo(() => {
    const seen = new Map<string, StepInputDef>();
    for (const step of workflow.steps) {
      for (const input of step.inputs) if (!seen.has(input.key)) seen.set(input.key, input);
    }
    return [...seen.values()];
  }, [workflow]);

  const orderedSteps = useMemo(
    () => [...workflow.steps].sort((a, b) => a.order - b.order),
    [workflow],
  );

  async function handleRun() {
    setRunning(true);
    setResult(null);
    setStates(new Map());

    const deps: RunDeps = {
      getRequestTemplate: makeTemplateResolver(catalog),
      proxy: api.proxy,
      env,
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
          <span className="badge">{workflow.group}</span>
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
            <StepCard key={step.id} step={step} state={states.get(step.id)} />
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
