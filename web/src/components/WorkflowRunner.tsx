import { useEffect, useMemo, useRef, useState } from "react";

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
  WorkflowStep,
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

  // 중간 입력: 실행이 스텝 뒤에서 멈춰 폼을 띄우고, 제출 시 Promise를 resolve해 재개한다.
  const [midPrompt, setMidPrompt] = useState<{
    uid: string;
    step: WorkflowStep;
    response: unknown;
    resolve: (v: Record<string, Primitive>) => void;
  } | null>(null);
  const [midValues, setMidValues] = useState<Record<string, Primitive>>({});
  // 실행에 사용된 입력값(기본 + 중간) 누적 — 실행 후 이력에 기록
  const runInputsRef = useRef<Record<string, Primitive>>({});

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
    setMidPrompt(null);
    runInputsRef.current = { ...values }; // 기본 입력값 스냅샷 (중간 입력은 제출 시 병합)

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
      // 중간 입력: 폼을 띄우고 사용자가 "계속"을 누를 때까지 대기
      collectMidInputs: ({ step, uid, response }) =>
        new Promise((resolve) => {
          setMidValues({});
          setMidPrompt({ uid, step, response, resolve });
        }),
    };

    const onStepUpdate = (s: StepExecutionState) =>
      setStates((prev) => new Map(prev).set(s.stepId, s));

    try {
      const res = await runWorkflow(workflow, values, deps, onStepUpdate);
      // 실행에 쓰인 입력값(기본+중간)을 이력에 기록 (서버가 비밀번호 등 리댁션)
      await api
        .recordExecutionInputs(res.executionId, runInputsRef.current, workflow.id)
        .catch(() => {});
      setResult(res);
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function submitMid() {
    if (!midPrompt) return;
    Object.assign(runInputsRef.current, midValues); // 중간 입력도 이력 기록 대상
    midPrompt.resolve({ ...midValues });
    setMidPrompt(null);
    setMidValues({});
  }

  // 중간 입력 폼(스텝 카드 하단에 렌더) — 모든 항목이 채워져야 "계속" 활성화
  const midComplete =
    !!midPrompt &&
    midPrompt.step.midInputs!.every((d) => {
      const v = midValues[d.key];
      return v != null && v !== "";
    });

  const renderMidForm = () => {
    if (!midPrompt) return null;
    return (
      <div className="midinput-form">
        <div className="midinput-title">중간 입력 — 다음 스텝 전에 추가 정보를 입력하세요</div>
        <StepInputForm
          inputs={midPrompt.step.midInputs!}
          values={midValues}
          env={env}
          stepResponse={midPrompt.response}
          onChange={(key, value) => setMidValues((v) => ({ ...v, [key]: value }))}
        />
        <div className="input-run-row">
          <button className="primary" onClick={submitMid} disabled={!midComplete}>
            계속 →
          </button>
        </div>
      </div>
    );
  };

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
      </header>

      {loadError ? <div className="error-banner">{loadError}</div> : null}

      <section className="panel">
        <h3>입력값</h3>
        <StepInputForm
          inputs={allInputs}
          values={values}
          env={env}
          onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
        />
        <div className="input-run-row">
          <button className="primary" onClick={handleRun} disabled={running || !!loadError}>
            {running ? "실행 중…" : "실행"}
          </button>
        </div>
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
              resultView={step.resultView}
              footer={midPrompt?.uid === step.id ? renderMidForm() : null}
            />
          ))}
        </div>
      </section>

      {midPrompt && !orderedSteps.some((s) => s.id === midPrompt.uid) ? (
        <section className="panel midinput-panel">{renderMidForm()}</section>
      ) : null}

      {result ? (
        <div className={`result-banner ${result.overallStatus.toLowerCase()}`}>
          <div className="result-banner-head">
            <span>
              실행 완료 — <strong>{result.overallStatus}</strong>
            </span>
            <button className="link" onClick={() => onOpenExecution(result.executionId)}>
              워크플로우 이력에서 열기 →
            </button>
          </div>
          <div className="share-row">
            <code>{`${location.origin}/executions/${result.executionId}`}</code>
            <button
              className="link"
              onClick={() =>
                navigator.clipboard?.writeText(
                  `${location.origin}/executions/${result.executionId}`,
                )
              }
            >
              공유 링크 복사
            </button>
          </div>
        </div>
      ) : null}
    </div>
    </ApiComboProvider>
  );
}
