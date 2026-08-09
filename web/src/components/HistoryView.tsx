import { useEffect, useState } from "react";

import { api, type ExecutionSummary } from "../api/client";
import type { StepExecutionState } from "../types";
import { StepCard } from "./StepCard";

interface LogEntry {
  step_id: string;
  request?: { method: string; url: string; headers: Record<string, string>; body?: unknown };
  response?: { status: number | null; body: unknown };
  elapsed_ms?: number;
  timestamp?: number;
}

function toStepState(entry: LogEntry): StepExecutionState {
  const status = entry.response?.status;
  return {
    stepId: entry.step_id,
    status: status != null && status >= 200 && status < 300 ? "SUCCESS" : "FAILED",
    request: entry.request as StepExecutionState["request"],
    response: entry.response?.body,
  };
}

export function ExecutionDetail({ executionId }: { executionId: string }) {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getExecution(executionId)
      .then((r) => alive && setEntries(r.steps as LogEntry[]))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [executionId]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!entries) return <p className="muted">불러오는 중…</p>;

  return (
    <div>
      <div className="share-row">
        <code>#/executions/{executionId}</code>
        <button
          className="link"
          onClick={() =>
            navigator.clipboard?.writeText(
              `${location.origin}${location.pathname}#/executions/${executionId}`,
            )
          }
        >
          공유 링크 복사
        </button>
      </div>
      <div className="step-list">
        {entries.map((entry, i) => (
          <StepCard
            key={`${entry.step_id}-${i}`}
            step={{ id: entry.step_id, order: i + 1, name: entry.step_id }}
            state={toStepState(entry)}
          />
        ))}
      </div>
    </div>
  );
}

export function ExecutionList({
  onOpen,
}: {
  onOpen: (executionId: string) => void;
}) {
  const [rows, setRows] = useState<ExecutionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listExecutions()
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <p className="muted">불러오는 중…</p>;
  if (rows.length === 0) return <p className="muted">아직 실행 이력이 없습니다.</p>;

  return (
    <ul className="exec-list">
      {rows.map((r) => (
        <li key={r.execution_id}>
          <button className="exec-row" onClick={() => onOpen(r.execution_id)}>
            <span className={`dot ${r.overall_status.toLowerCase()}`} />
            <span className="exec-wf">{r.workflow_id ?? "(워크플로우 미상)"}</span>
            <span className="muted">{r.step_count} 스텝</span>
            <span className="muted">
              {r.started_at ? new Date(r.started_at * 1000).toLocaleString() : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
