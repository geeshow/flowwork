import { useEffect, useMemo, useState } from "react";

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
  onRun: (group: string, id: string) => void;
  onEdit: (group: string, id: string) => void;
  onNew: () => void;
}) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);

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

  // 그룹별로 묶기 (표준 그룹은 항상 탭으로 노출, 데이터에만 있는 그룹은 뒤에 추가)
  const groups = useMemo(() => {
    const byGroup = new Map<string, WorkflowSummary[]>();
    for (const g of GROUP_ORDER) byGroup.set(g, []);
    for (const w of rows ?? []) {
      const list = byGroup.get(w.group) ?? [];
      list.push(w);
      byGroup.set(w.group, list);
    }
    return orderGroups([...byGroup.keys()]).map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, [rows]);

  // 활성 그룹 기본값 = 첫 그룹
  useEffect(() => {
    if (groups.length > 0 && (activeGroup === null || !groups.some((g) => g.group === activeGroup))) {
      setActiveGroup(groups[0].group);
    }
  }, [groups, activeGroup]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <p className="muted">불러오는 중…</p>;

  const active = groups.find((g) => g.group === activeGroup) ?? null;

  return (
    <section>
      <div className="panel-head">
        <h2>워크플로우</h2>
        <button className="primary" onClick={onNew}>
          + 새 워크플로우
        </button>
      </div>

      {groups.length === 0 ? (
        <p className="muted">등록된 워크플로우가 없습니다. "새 워크플로우"로 시작하세요.</p>
      ) : (
        <>
          <div className="group-tabs">
            {groups.map((g) => (
              <button
                key={g.group}
                className={`group-tab ${g.group === activeGroup ? "active" : ""}`}
                onClick={() => setActiveGroup(g.group)}
              >
                {g.group}
                <span className="group-count">{g.items.length}</span>
              </button>
            ))}
          </div>

          {active && active.items.length === 0 ? (
            <p className="muted">이 그룹에는 아직 등록된 업무가 없습니다. "새 워크플로우"로 추가하세요.</p>
          ) : (
            <ul className="wf-list">
              {active?.items.map((w) => (
                <li key={`${w.group}/${w.id}`} className="wf-item">
                  <button className="wf-row" onClick={() => onRun(w.group, w.id)}>
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
        </>
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
