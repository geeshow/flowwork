import { useEffect, useMemo, useState } from "react";

import { api, type WorkflowSummary } from "./api/client";
import { ExecutionDetail, ExecutionList } from "./components/HistoryView";
import { WorkflowEditor } from "./components/editor/WorkflowEditor";
import { WorkflowRunner } from "./components/WorkflowRunner";
import type { Workflow } from "./types";

type Route =
  | { view: "workflows" }
  | { view: "run"; id: string }
  | { view: "new" }
  | { view: "edit"; id: string }
  | { view: "history" }
  | { view: "execution"; executionId: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, a] = hash.split("/");
  if (head === "executions" && a) return { view: "execution", executionId: a };
  if (head === "run" && a) return { view: "run", id: a };
  if (head === "new") return { view: "new" };
  if (head === "edit" && a) return { view: "edit", id: a };
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
            onRun={(i) => go(`#/run/${i}`)}
            onEdit={(i) => go(`#/edit/${i}`)}
            onNew={() => go("#/new")}
          />
        ) : null}
        {route.view === "run" ? (
          <RunPage
            id={route.id}
            onOpenExecution={(id) => go(`#/executions/${id}`)}
            onEdit={(i) => go(`#/edit/${i}`)}
          />
        ) : null}
        {route.view === "new" ? (
          <WorkflowEditor mode="new" onSaved={(i) => go(`#/run/${i}`)} onCancel={() => go("#/")} />
        ) : null}
        {route.view === "edit" ? (
          <WorkflowEditor
            mode="edit"
            id={route.id}
            onSaved={(i) => go(`#/run/${i}`)}
            onCancel={() => go(`#/run/${route.id}`)}
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

// 그룹 표시 순서 (미지정 그룹은 이 뒤에 가나다순으로 붙는다)
const GROUP_ORDER = ["계좌", "계정", "매매", "인증", "마케팅", "상품"];

function orderGroups(groups: string[]): string[] {
  const known = GROUP_ORDER.filter((g) => groups.includes(g));
  const rest = groups.filter((g) => !GROUP_ORDER.includes(g)).sort((a, b) => a.localeCompare(b, "ko"));
  return [...known, ...rest];
}

function WorkflowsPage({
  onRun,
  onEdit,
  onNew,
}: {
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
}) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);

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

  // 도메인 탭 (표준 도메인은 항상 노출) → 도메인 안에서 업무별로 묶기
  const domains = useMemo(() => {
    const byDomain = new Map<string, WorkflowSummary[]>();
    for (const d of GROUP_ORDER) byDomain.set(d, []);
    for (const w of rows ?? []) {
      const d = w.domain.normalize("NFC"); // 한글 조합/분해 표현 통일
      const list = byDomain.get(d) ?? [];
      list.push(w);
      byDomain.set(d, list);
    }
    return orderGroups([...byDomain.keys()]).map((d) => ({ domain: d, items: byDomain.get(d)! }));
  }, [rows]);

  useEffect(() => {
    if (domains.length > 0 && (activeDomain === null || !domains.some((d) => d.domain === activeDomain))) {
      setActiveDomain(domains[0].domain);
    }
  }, [domains, activeDomain]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <p className="muted">불러오는 중…</p>;

  const active = domains.find((d) => d.domain === activeDomain) ?? null;

  // 활성 도메인의 항목을 업무(task)별로 그룹화
  const byTask = new Map<string, WorkflowSummary[]>();
  for (const w of active?.items ?? []) {
    const list = byTask.get(w.task) ?? [];
    list.push(w);
    byTask.set(w.task, list);
  }
  const tasks = [...byTask.keys()].sort((a, b) => a.localeCompare(b, "ko"));

  return (
    <section>
      <div className="panel-head">
        <h2>워크플로우</h2>
        <button className="primary" onClick={onNew}>
          + 새 워크플로우
        </button>
      </div>

      <div className="group-tabs">
        {domains.map((d) => (
          <button
            key={d.domain}
            className={`group-tab ${d.domain === activeDomain ? "active" : ""}`}
            onClick={() => setActiveDomain(d.domain)}
          >
            {d.domain}
            <span className="group-count">{d.items.length}</span>
          </button>
        ))}
      </div>

      {tasks.length === 0 ? (
        <p className="muted">이 도메인에는 아직 등록된 업무가 없습니다. "새 워크플로우"로 추가하세요.</p>
      ) : (
        tasks.map((task) => (
          <div key={task} className="task-group">
            <h3 className="task-title">{task}</h3>
            <ul className="wf-list">
              {byTask.get(task)!.map((w) => (
                <li key={w.id} className="wf-item">
                  <button className="wf-row" onClick={() => onRun(w.id)}>
                    <span className="wf-name">{w.name}</span>
                    {w.description ? <span className="muted">{w.description}</span> : null}
                  </button>
                  <button className="wf-edit" onClick={() => onEdit(w.id)} title="편집">
                    편집
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

function RunPage({
  id,
  onOpenExecution,
  onEdit,
}: {
  id: string;
  onOpenExecution: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const [wf, setWf] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setWf(null);
    api
      .getWorkflow(id)
      .then((w) => alive && setWf(w))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [id]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!wf) return <p className="muted">불러오는 중…</p>;
  return (
    <>
      <div className="run-topbar">
        <button className="link" onClick={() => (location.hash = "#/")}>
          ← 워크플로우 목록
        </button>
        <button className="link" onClick={() => onEdit(id)}>
          편집 →
        </button>
      </div>
      <WorkflowRunner workflow={wf} onOpenExecution={onOpenExecution} />
    </>
  );
}
