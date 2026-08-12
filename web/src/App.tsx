import { useEffect, useState } from "react";

import { api, type WorkflowSummary } from "./api/client";
import { ExecutionDetail, HistoryMain } from "./components/HistoryView";
import { ApicShell } from "./components/apic/ApicShell";
import { EditPage, type EditorPage } from "./components/edit/EditPage";
import { WorkflowLayout } from "./components/WorkflowLayout";
import { WorkflowRunner } from "./components/WorkflowRunner";
import { colorForDomain } from "./domainPalette";
import type { Workflow } from "./types";

type Route =
  | { view: "workflows" }
  | { view: "task"; domain: string; task: string }
  | { view: "run"; id: string }
  | { view: "editor"; page: EditorPage; branch?: string }
  | { view: "history"; domain?: string; task?: string }
  | { view: "execution"; executionId: string }
  | { view: "apic"; ws?: string; branch?: string };

// 경로(pathname) → Route. 해시 없는 깔끔한 URL(/executions/{id} 등)을 파싱한다.
function parseLocation(): Route {
  const parts = location.pathname.split("/").filter(Boolean);
  const [head, a, b] = parts;
  // 손상된 인코딩(%E 등)이 와도 앱이 죽지 않도록 실패 시 원문을 그대로 쓴다
  const dec = (s?: string) => {
    if (!s) return undefined;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (head === "executions" && a) return { view: "execution", executionId: a };
  if (head === "run" && a) return { view: "run", id: a };
  if (head === "t" && a && b) return { view: "task", domain: dec(a)!, task: dec(b)! };
  if (head === "apic") {
    // API 콜렉션도 브랜치 편집 플로우: /apic/b/{branch}/{ws?} | /apic/{ws?}
    if (a === "b" && b) return { view: "apic", branch: dec(b), ws: dec(parts[3]) };
    return { view: "apic", ws: dec(a) };
  }
  if (head === "editor") {
    // 수정 모드는 브랜치를 URL에 담는다: /editor/b/{branch}/… (없으면 develop 기본)
    let branch: string | undefined;
    let rest = parts.slice(1);
    if (rest[0] === "b" && rest[1]) {
      branch = dec(rest[1]);
      rest = rest.slice(2);
    }
    const [p0, p1, p2] = rest;
    const page: EditorPage =
      p0 === "t" && p1 && p2
        ? { kind: "task", domain: dec(p1)!, task: dec(p2)! }
        : p0 === "run" && p1
          ? { kind: "run", id: p1 }
          : p0 === "new"
            ? { kind: "new", domain: dec(p1), task: dec(p2) }
            : p0 === "edit" && p1
              ? { kind: "edit", id: p1 }
              : p0 === "merge"
                ? { kind: "merge" }
                : { kind: "home" };
    return { view: "editor", page, branch };
  }
  if (head === "history") {
    if (a === "t" && b && parts[3]) return { view: "history", domain: dec(b), task: dec(parts[3]) };
    return { view: "history" };
  }
  return { view: "workflows" };
}

// History API 네비게이션. pushState 후 popstate를 발생시켜 App이 경로를 다시 파싱한다.
// (정적 호스팅 배포 시에는 SPA fallback 설정 필요 — 모든 경로에서 index.html 서빙.)
function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const taskPath = (domain: string, task: string) =>
  `/t/${encodeURIComponent(domain)}/${encodeURIComponent(task)}`;
const historyTaskPath = (domain: string, task: string) =>
  `/history/t/${encodeURIComponent(domain)}/${encodeURIComponent(task)}`;

export default function App() {
  const [route, setRoute] = useState<Route>(parseLocation());

  useEffect(() => {
    const onPop = () => setRoute(parseLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = navigate;

  const inWorkflows = route.view === "workflows" || route.view === "run" || route.view === "task";
  const navHistoryActive = route.view === "history" || route.view === "execution";

  return (
    <div className="app">
      <nav className="topbar">
        <button className="brand" onClick={() => go("/")}>
          flowwork
        </button>
        <div className="nav-links">
          <button className={inWorkflows ? "active" : ""} onClick={() => go("/")}>
            워크플로우
          </button>
          <button className={route.view === "editor" ? "active" : ""} onClick={() => go("/editor")}>
            편집
          </button>
          <button className={navHistoryActive ? "active" : ""} onClick={() => go("/history")}>
            워크플로우 이력
          </button>
          <button className={route.view === "apic" ? "active" : ""} onClick={() => go("/apic")}>
            API 콜렉션
          </button>
        </div>
      </nav>

      <main className="content">
        {inWorkflows ? (
          <WorkflowLayout
            title="워크플로우"
            activeId={route.view === "run" ? route.id : undefined}
            activeTask={route.view === "task" ? { domain: route.domain, task: route.task } : undefined}
            onOpenTask={(d, t) => go(taskPath(d, t))}
          >
            {route.view === "run" ? (
              <RunDetail id={route.id} onOpenExecution={(id) => go(`/executions/${id}`)} />
            ) : route.view === "task" ? (
              <TaskDetail domain={route.domain} task={route.task} onRun={(i) => go(`/run/${i}`)} />
            ) : (
              <div className="detail-empty">
                <p className="muted">
                  왼쪽에서 업무를 선택하면 해당 업무의 워크플로우가 여기에 표시됩니다.
                </p>
                <p className="muted">워크플로우 등록·수정은 상단 "편집" 메뉴에서 합니다.</p>
              </div>
            )}
          </WorkflowLayout>
        ) : null}
        {route.view === "editor" ? <EditPage page={route.page} branch={route.branch} go={go} /> : null}
        {route.view === "history" ? (
          <WorkflowLayout
            title="워크플로우 이력"
            activeTask={route.domain && route.task ? { domain: route.domain, task: route.task } : undefined}
            onOpenTask={(d, t) => go(historyTaskPath(d, t))}
          >
            <section>
              <div className="task-detail-head">
                <div className="crumb">
                  <h2>워크플로우 이력</h2>
                  {route.domain && route.task ? (
                    <>
                      <span className="muted">·</span>
                      <span className="muted">
                        {route.domain} / {route.task}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              <HistoryMain
                activeTask={route.domain && route.task ? { domain: route.domain, task: route.task } : undefined}
                onOpen={(id) => go(`/executions/${id}`)}
              />
            </section>
          </WorkflowLayout>
        ) : null}
        {route.view === "apic" ? (
          <ApicShell ws={route.ws} branch={route.branch} go={go} />
        ) : null}
        {route.view === "execution" ? (
          <WorkflowLayout title="워크플로우 이력" onOpenTask={(d, t) => go(historyTaskPath(d, t))}>
            <section className="execution-page">
              <button className="link" onClick={() => go("/history")}>
                ← 워크플로우 이력
              </button>
              <ExecutionDetail executionId={route.executionId} />
            </section>
          </WorkflowLayout>
        ) : null}
      </main>
    </div>
  );
}

/** 선택한 업무(도메인/업무) 하위의 모든 워크플로우(작업)를 한 화면에 나열한다. (실행 전용) */
function TaskDetail({
  domain,
  task,
  onRun,
}: {
  domain: string;
  task: string;
  onRun: (id: string) => void;
}) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listWorkflows(), api.getDomainColors()])
      .then(([r, c]) => {
        if (!alive) return;
        setRows(r);
        setColors(c);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <p className="muted">불러오는 중…</p>;

  const color = colorForDomain(domain.normalize("NFC"), colors);
  const items = rows.filter(
    (w) => w.domain.normalize("NFC") === domain.normalize("NFC") && w.task.normalize("NFC") === task.normalize("NFC"),
  );

  return (
    <section>
      <div className="task-detail-head">
        <div className="crumb">
          <span className="task-bullet lg" style={{ background: color }} />
          <span className="muted">{domain}</span>
          <span className="muted">/</span>
          <h2>{task}</h2>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="detail-empty">
          <p className="muted">이 업무에는 아직 워크플로우가 없습니다. "편집" 메뉴에서 추가하세요.</p>
        </div>
      ) : (
        <div className="wf-card-grid">
          {items.map((w) => (
            <button
              key={w.id}
              className="wf-card wf-card-main"
              style={{ borderLeftColor: color }}
              onClick={() => onRun(w.id)}
            >
              <span className="wf-card-title">
                <span className="task-bullet" style={{ background: color }} />
                {w.name}
              </span>
              {w.description ? <span className="muted">{w.description}</span> : null}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function RunDetail({
  id,
  onOpenExecution,
}: {
  id: string;
  onOpenExecution: (id: string) => void;
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
        <button className="link" onClick={() => navigate(taskPath(wf.domain, wf.task))}>
          ← {wf.domain} / {wf.task}
        </button>
      </div>
      <WorkflowRunner workflow={wf} onOpenExecution={onOpenExecution} />
    </>
  );
}
