import { useEffect, useMemo, useState } from "react";

import { api, type ExecutionSummary, type WorkflowSummary } from "../api/client";
import { colorForDomain } from "../domainPalette";
import type { StepExecutionState, Workflow } from "../types";
import { StepCard, stepTypeMeta } from "./StepCard";

interface LogEntry {
  step_id?: string;
  workflow_id?: string;
  request?: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response?: { status: number | null; body: unknown };
  elapsed_ms?: number;
  timestamp?: number;
  // 메타 엔트리(입력값 기록)
  kind?: string;
  values?: Record<string, unknown>;
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function toStepState(entry: LogEntry): StepExecutionState {
  const status = entry.response?.status;
  return {
    stepId: entry.step_id ?? "",
    status: status != null && status >= 200 && status < 300 ? "SUCCESS" : "FAILED",
    request: entry.request as StepExecutionState["request"],
    response: entry.response?.body,
  };
}

function overallStatus(entries: LogEntry[]): "SUCCESS" | "FAILED" {
  const ok = entries.every((e) => {
    const s = e.response?.status;
    return s != null && s >= 200 && s < 300;
  });
  return ok ? "SUCCESS" : "FAILED";
}

/**
 * 실행 상세 — 저장된 실행 로그를 불러와, 실행 화면과 "동일하게" 렌더한다.
 * 로그의 workflow_id로 워크플로우를 로드해 스텝 이름/결과표(resultView)를 함께 보여준다.
 * (응답은 저장 시 리댁션된 사본이라 비밀번호 등은 마스킹된 채 공유된다.)
 */
export function ExecutionDetail({ executionId }: { executionId: string }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [wfById, setWfById] = useState<Map<string, Workflow>>(new Map());
  const [topWfId, setTopWfId] = useState<string | undefined>(undefined);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setWfById(new Map());
    setTopWfId(undefined);
    api
      .getExecution(executionId)
      .then(async (r) => {
        if (!alive) return;
        const steps = r.steps as LogEntry[];
        setEntries(steps);
        api.getDomainColors().then((c) => alive && setColors(c)).catch(() => {});
        // 최상위 워크플로우: 입력값 엔트리에 기록된 id 우선(첫 스텝이 하위 업무 연결일 수 있음)
        const inputs = steps.find((e) => e.kind === "inputs");
        const firstStep = steps.find((e) => e.step_id);
        const top = inputs?.workflow_id ?? firstStep?.workflow_id;
        if (alive) setTopWfId(top);
        // 로그에 등장하는 모든 워크플로우 로드 (연결된 하위 업무 포함) → 스텝 이름/결과표 복원
        const ids = [...new Set(steps.map((e) => e.workflow_id).filter(Boolean) as string[])];
        if (top && !ids.includes(top)) ids.push(top);
        const loaded = await Promise.all(
          ids.map((id) =>
            api
              .getWorkflow(id)
              .then((w) => [id, w] as const)
              .catch(() => null),
          ),
        );
        if (alive) setWfById(new Map(loaded.filter((x): x is readonly [string, Workflow] => x != null)));
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [executionId]);

  const topWf = topWfId ? wfById.get(topWfId) : undefined;
  // 각 로그 엔트리를 자기 워크플로우의 스텝(리프 id)으로 해석하는 헬퍼
  const stepFor = (entry: LogEntry) => {
    const wf = entry.workflow_id ? wfById.get(entry.workflow_id) : undefined;
    const leafId = entry.step_id?.split("/").pop();
    return wf?.steps.find((s) => s.id === leafId);
  };
  // 입력값 key → label (최상위 기본 입력값 + 모든 워크플로우의 중간 입력)
  const inputLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of topWf?.baseInputs ?? []) m.set(b.key, b.label);
    for (const w of wfById.values()) for (const s of w.steps) for (const mi of s.midInputs ?? []) m.set(mi.key, mi.label);
    return m;
  }, [topWf, wfById]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!entries) return <p className="muted">불러오는 중…</p>;

  const stepEntries = entries.filter((e) => e.step_id);
  const inputsEntry = entries.find((e) => e.kind === "inputs");
  const status = overallStatus(stepEntries);
  const startedAt = stepEntries[0]?.timestamp;
  const color = topWf ? colorForDomain(topWf.domain.normalize("NFC"), colors) : "var(--muted)";
  const shareUrl = `${location.origin}/executions/${executionId}`;

  return (
    <div>
      <div className="exec-detail-head">
        <div className="crumb">
          <span className="task-bullet lg" style={{ background: color }} />
          {topWf ? (
            <>
              <span className="muted">{topWf.domain}</span>
              <span className="muted">/</span>
              <span className="muted">{topWf.task}</span>
              <span className="muted">/</span>
              <h2>{topWf.name}</h2>
            </>
          ) : (
            <h2>{topWfId ?? "실행 결과"}</h2>
          )}
          <span className={`status-badge ${status.toLowerCase()}`}>
            {status === "SUCCESS" ? "성공" : "실패"}
          </span>
        </div>
        {startedAt ? (
          <span className="muted">{new Date(startedAt * 1000).toLocaleString()}</span>
        ) : null}
      </div>

      <div className="share-row">
        <code>{shareUrl}</code>
        <button className="link" onClick={() => navigator.clipboard?.writeText(shareUrl)}>
          공유 링크 복사
        </button>
      </div>

      {inputsEntry?.values && Object.keys(inputsEntry.values).length > 0 ? (
        <div className="exec-inputs">
          <div className="exec-inputs-title">입력값</div>
          <table className="result-table kv">
            <tbody>
              {Object.entries(inputsEntry.values).map(([k, v]) => (
                <tr key={k}>
                  <th>
                    {inputLabels.get(k) ?? k} <code className="field-key">{k}</code>
                  </th>
                  <td>{cell(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="step-list">
        {stepEntries.map((entry, i) => {
          const step = stepFor(entry);
          const meta = step
            ? stepTypeMeta(step, (id) => {
                const w = wfById.get(id);
                return w ? { domain: w.domain, task: w.task, name: w.name } : undefined;
              })
            : undefined;
          return (
            <StepCard
              key={`${entry.step_id}-${i}`}
              step={{ id: entry.step_id!, order: i + 1, name: step?.name ?? entry.step_id! }}
              state={toStepState(entry)}
              resultView={step?.resultView}
              typeLabel={meta?.typeLabel}
              category={meta?.category}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * 워크플로우 이력 목록 — 실행들을 워크플로우와 조인해
 * "도메인 / 업무 / 작업명 [성공여부] 실행시간" 형태로 나열한다.
 * activeTask가 있으면 그 업무의 실행만 보여준다.
 */
export function HistoryMain({
  activeTask,
  onOpen,
}: {
  activeTask?: { domain: string; task: string };
  onOpen: (executionId: string) => void;
}) {
  const [execs, setExecs] = useState<ExecutionSummary[] | null>(null);
  const [wfs, setWfs] = useState<WorkflowSummary[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listExecutions(), api.listWorkflows(), api.getDomainColors()])
      .then(([e, w, c]) => {
        if (!alive) return;
        setExecs(e);
        setWfs(w);
        setColors(c);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  const wfById = useMemo(() => new Map(wfs.map((w) => [w.id, w])), [wfs]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!execs) return <p className="muted">불러오는 중…</p>;

  const nfc = (s: string) => s.normalize("NFC");
  const rows = execs
    .map((e) => {
      const wf = e.workflow_id ? wfById.get(e.workflow_id) : undefined;
      return { e, domain: wf?.domain, task: wf?.task, name: wf?.name };
    })
    .filter(
      (r) =>
        !activeTask ||
        (r.domain != null &&
          r.task != null &&
          nfc(r.domain) === nfc(activeTask.domain) &&
          nfc(r.task) === nfc(activeTask.task)),
    );

  if (rows.length === 0)
    return (
      <p className="muted">
        {activeTask ? "이 업무의 실행 이력이 없습니다." : "아직 실행 이력이 없습니다."}
      </p>
    );

  return (
    <ul className="exec-list">
      {rows.map(({ e, domain, task, name }) => {
        const color = domain ? colorForDomain(nfc(domain), colors) : "var(--muted)";
        return (
          <li key={e.execution_id}>
            <button className="exec-row" onClick={() => onOpen(e.execution_id)}>
              <span className="exec-crumb">
                <span className="task-bullet" style={{ background: color }} />
                <span className="muted">{domain ?? "?"}</span>
                <span className="crumb-sep">/</span>
                <span className="muted">{task ?? "?"}</span>
                <span className="crumb-sep">/</span>
                <span className="exec-wf">{name ?? "(삭제된 워크플로우)"}</span>
              </span>
              <span className={`status-badge ${e.overall_status.toLowerCase()}`}>
                {e.overall_status === "SUCCESS" ? "성공" : "실패"}
              </span>
              <span className="muted exec-time">
                {e.started_at ? new Date(e.started_at * 1000).toLocaleString() : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
