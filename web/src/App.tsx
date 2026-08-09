import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api, type WorkflowSummary } from "./api/client";
import { ExecutionDetail, ExecutionList } from "./components/HistoryView";
import { WorkflowEditor } from "./components/editor/WorkflowEditor";
import { WorkflowRunner } from "./components/WorkflowRunner";
import type { Workflow } from "./types";

type Route =
  | { view: "workflows" }
  | { view: "run"; id: string }
  | { view: "new"; domain?: string }
  | { view: "edit"; id: string }
  | { view: "history" }
  | { view: "execution"; executionId: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, a] = hash.split("/");
  if (head === "executions" && a) return { view: "execution", executionId: a };
  if (head === "run" && a) return { view: "run", id: a };
  if (head === "new") return { view: "new", domain: a ? decodeURIComponent(a) : undefined };
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

  const navHistoryActive = route.view === "history" || route.view === "execution";

  return (
    <div className="app">
      <nav className="topbar">
        <button className="brand" onClick={() => go("#/")}>
          flowwork
        </button>
        <div className="nav-links">
          <button className={route.view === "workflows" || route.view === "run" ? "active" : ""} onClick={() => go("#/")}>
            워크플로우
          </button>
          <button className={navHistoryActive ? "active" : ""} onClick={() => go("#/history")}>
            실행 이력
          </button>
        </div>
      </nav>

      <main className="content">
        {route.view === "workflows" || route.view === "run" ? (
          <WorkflowLayout
            activeId={route.view === "run" ? route.id : undefined}
            onRun={(i) => go(`#/run/${i}`)}
            onNew={(domain) => go(domain ? `#/new/${encodeURIComponent(domain)}` : "#/new")}
          >
            {route.view === "run" ? (
              <RunDetail
                id={route.id}
                onOpenExecution={(id) => go(`#/executions/${id}`)}
                onEdit={(i) => go(`#/edit/${i}`)}
              />
            ) : (
              <div className="detail-empty">
                <p className="muted">왼쪽에서 워크플로우를 선택해 실행하거나, "새 워크플로우"로 등록하세요.</p>
              </div>
            )}
          </WorkflowLayout>
        ) : null}
        {route.view === "new" ? (
          <WorkflowEditor
            mode="new"
            initialDomain={route.domain}
            onSaved={(i) => go(`#/run/${i}`)}
            onCancel={() => go("#/")}
          />
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

/**
 * 워크플로우 목록(도메인 탭 + 업무별 목록)을 좌측 사이드바에 고정으로 두고,
 * 우측 detail 영역에 실행 화면(children)을 보여주는 master–detail 레이아웃.
 * 처리(실행) 페이지로 들어가도 도메인/업무 목록이 화면에 유지된다.
 */
function WorkflowLayout({
  activeId,
  onRun,
  onNew,
  children,
}: {
  activeId?: string;
  onRun: (id: string) => void;
  onNew: (domain?: string) => void;
  children: ReactNode;
}) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  const userPicked = useRef(false);

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

  // 실행 중인 워크플로우가 있으면 그 도메인을 기본 선택 (사용자가 직접 탭을 고르기 전까지)
  const activeWfDomain = useMemo(
    () => rows?.find((w) => w.id === activeId)?.domain.normalize("NFC") ?? null,
    [rows, activeId],
  );

  useEffect(() => {
    if (domains.length === 0) return;
    setActiveDomain((cur) => {
      if (userPicked.current && cur && domains.some((d) => d.domain === cur)) return cur;
      if (activeWfDomain && domains.some((d) => d.domain === activeWfDomain)) return activeWfDomain;
      if (cur && domains.some((d) => d.domain === cur)) return cur;
      return domains[0].domain;
    });
  }, [domains, activeWfDomain]);

  const pickDomain = (d: string) => {
    userPicked.current = true;
    setActiveDomain(d);
  };

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
    <div className="workspace">
      <aside className="wf-sidebar">
        <div className="sidebar-head">
          <h2>워크플로우</h2>
          <button className="primary small" onClick={() => onNew(activeDomain ?? undefined)}>
            + 새로
          </button>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="group-tabs">
          {domains.map((d) => (
            <button
              key={d.domain}
              className={`group-tab ${d.domain === activeDomain ? "active" : ""}`}
              onClick={() => pickDomain(d.domain)}
            >
              {d.domain}
              <span className="group-count">{d.items.length}</span>
            </button>
          ))}
        </div>

        {!rows ? (
          <p className="muted">불러오는 중…</p>
        ) : tasks.length === 0 ? (
          <p className="muted">이 도메인에는 아직 업무가 없습니다.</p>
        ) : (
          <div className="sidebar-list">
            {tasks.map((task) => (
              <div key={task} className="task-group">
                <h3 className="task-title">{task}</h3>
                <ul className="wf-nav-list">
                  {byTask.get(task)!.map((w) => (
                    <li key={w.id}>
                      <button
                        className={`wf-nav-item ${w.id === activeId ? "active" : ""}`}
                        onClick={() => onRun(w.id)}
                        title={w.description || w.name}
                      >
                        {w.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </aside>

      <div className="wf-detail">{children}</div>
    </div>
  );
}

function RunDetail({
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
    setError(null);
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
        <span className="run-crumb muted">
          {wf.domain} / {wf.task}
        </span>
        <button className="link" onClick={() => onEdit(id)}>
          편집 →
        </button>
      </div>
      <WorkflowRunner workflow={wf} onOpenExecution={onOpenExecution} />
    </>
  );
}
