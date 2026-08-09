import { useEffect, useState } from "react";

import { api, type WorkflowSummary } from "./api/client";
import { ExecutionDetail, ExecutionList } from "./components/HistoryView";
import { WorkflowRunner } from "./components/WorkflowRunner";
import type { Workflow } from "./types";

type Route =
  | { view: "workflows" }
  | { view: "run"; group: string; id: string }
  | { view: "history" }
  | { view: "execution"; executionId: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, a, b] = hash.split("/");
  if (head === "executions" && a) return { view: "execution", executionId: a };
  if (head === "run" && a && b) return { view: "run", group: a, id: b };
  if (head === "history") return { view: "history" };
  return { view: "workflows" };
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (hash: string) => {
    location.hash = hash;
  };

  return (
    <div className="app">
      <nav className="topbar">
        <button className="brand" onClick={() => go("#/")}>
          flowwork
        </button>
        <div className="nav-links">
          <button className={route.view === "workflows" ? "active" : ""} onClick={() => go("#/")}>
            워크플로우
          </button>
          <button
            className={route.view === "history" || route.view === "execution" ? "active" : ""}
            onClick={() => go("#/history")}
          >
            실행 이력
          </button>
        </div>
      </nav>

      <main className="content">
        {route.view === "workflows" ? <WorkflowsPage onRun={(g, i) => go(`#/run/${g}/${i}`)} /> : null}
        {route.view === "run" ? <RunPage group={route.group} id={route.id} onOpenExecution={(id) => go(`#/executions/${id}`)} /> : null}
        {route.view === "history" ? (
          <section>
            <h2>실행 이력</h2>
            <ExecutionList onOpen={(id) => go(`#/executions/${id}`)} />
          </section>
        ) : null}
        {route.view === "execution" ? (
          <section>
            <button className="link" onClick={() => go("#/history")}>
              ← 목록
            </button>
            <h2>실행 상세</h2>
            <ExecutionDetail executionId={route.executionId} />
          </section>
        ) : null}
      </main>
    </div>
  );
}

function WorkflowsPage({ onRun }: { onRun: (group: string, id: string) => void }) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listWorkflows()
      .then((r) => alive && setRows(r))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <p className="muted">불러오는 중…</p>;
  if (rows.length === 0)
    return (
      <div className="empty">
        <h2>워크플로우</h2>
        <p className="muted">
          등록된 워크플로우가 없습니다. 서버의 <code>data/workflows/</code>에 JSON을 두거나
          시드 스크립트(<code>scripts/seed.py</code>)를 실행하세요.
        </p>
      </div>
    );

  return (
    <section>
      <h2>워크플로우</h2>
      <ul className="wf-list">
        {rows.map((w) => (
          <li key={`${w.group}/${w.id}`}>
            <button className="wf-row" onClick={() => onRun(w.group, w.id)}>
              <span className="badge">{w.group}</span>
              <span className="wf-name">{w.name}</span>
              {w.description ? <span className="muted">{w.description}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RunPage({
  group,
  id,
  onOpenExecution,
}: {
  group: string;
  id: string;
  onOpenExecution: (id: string) => void;
}) {
  const [wf, setWf] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setWf(null);
    api
      .getWorkflow(group, id)
      .then((w) => alive && setWf(w))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [group, id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!wf) return <p className="muted">불러오는 중…</p>;
  return (
    <>
      <button className="link" onClick={() => (location.hash = "#/")}>
        ← 워크플로우 목록
      </button>
      <WorkflowRunner workflow={wf} onOpenExecution={onOpenExecution} />
    </>
  );
}
