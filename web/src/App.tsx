import { useEffect, useState } from "react";

import { api, type WorkflowSummary } from "./api/client";
import { ExecutionDetail, ExecutionList } from "./components/HistoryView";
import { WorkflowEditor } from "./components/editor/WorkflowEditor";
import { WorkflowRunner } from "./components/WorkflowRunner";
import type { Workflow } from "./types";

type Route =
  | { view: "workflows" }
  | { view: "run"; group: string; id: string }
  | { view: "new" }
  | { view: "edit"; group: string; id: string }
  | { view: "history" }
  | { view: "execution"; executionId: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, a, b] = hash.split("/");
  if (head === "executions" && a) return { view: "execution", executionId: a };
  if (head === "run" && a && b) return { view: "run", group: a, id: b };
  if (head === "new") return { view: "new" };
  if (head === "edit" && a && b) return { view: "edit", group: a, id: b };
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
        {route.view === "workflows" ? (
          <WorkflowsPage
            onRun={(g, i) => go(`#/run/${g}/${i}`)}
            onEdit={(g, i) => go(`#/edit/${g}/${i}`)}
            onNew={() => go("#/new")}
          />
        ) : null}
        {route.view === "run" ? (
          <RunPage
            group={route.group}
            id={route.id}
            onOpenExecution={(id) => go(`#/executions/${id}`)}
            onEdit={(g, i) => go(`#/edit/${g}/${i}`)}
          />
        ) : null}
        {route.view === "new" ? (
          <WorkflowEditor mode="new" onSaved={(g, i) => go(`#/run/${g}/${i}`)} onCancel={() => go("#/")} />
        ) : null}
        {route.view === "edit" ? (
          <WorkflowEditor
            mode="edit"
            group={route.group}
            id={route.id}
            onSaved={(g, i) => go(`#/run/${g}/${i}`)}
            onCancel={() => go(`#/run/${route.group}/${route.id}`)}
          />
        ) : null}
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

function WorkflowsPage({
  onRun,
  onEdit,
  onNew,
}: {
  onRun: (group: string, id: string) => void;
  onEdit: (group: string, id: string) => void;
  onNew: () => void;
}) {
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

  return (
    <section>
      <div className="panel-head">
        <h2>워크플로우</h2>
        <button className="primary" onClick={onNew}>
          + 새 워크플로우
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted">등록된 워크플로우가 없습니다. "새 워크플로우"로 시작하세요.</p>
      ) : (
        <ul className="wf-list">
          {rows.map((w) => (
            <li key={`${w.group}/${w.id}`} className="wf-item">
              <button className="wf-row" onClick={() => onRun(w.group, w.id)}>
                <span className="badge">{w.group}</span>
                <span className="wf-name">{w.name}</span>
                {w.description ? <span className="muted">{w.description}</span> : null}
              </button>
              <button className="wf-edit" onClick={() => onEdit(w.group, w.id)} title="편집">
                편집
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RunPage({
  group,
  id,
  onOpenExecution,
  onEdit,
}: {
  group: string;
  id: string;
  onOpenExecution: (id: string) => void;
  onEdit: (group: string, id: string) => void;
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
      <div className="run-topbar">
        <button className="link" onClick={() => (location.hash = "#/")}>
          ← 워크플로우 목록
        </button>
        <button className="link" onClick={() => onEdit(group, id)}>
          편집 →
        </button>
      </div>
      <WorkflowRunner workflow={wf} onOpenExecution={onOpenExecution} />
    </>
  );
}
