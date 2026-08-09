import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { api, type WorkflowSummary } from "./api/client";
import { ExecutionDetail, HistoryMain } from "./components/HistoryView";
import { WorkflowEditor } from "./components/editor/WorkflowEditor";
import { WorkflowRunner } from "./components/WorkflowRunner";
import { colorForDomain } from "./domainPalette";
import type { Workflow } from "./types";

type Route =
  | { view: "workflows" }
  | { view: "task"; domain: string; task: string }
  | { view: "run"; id: string }
  | { view: "new"; domain?: string; task?: string }
  | { view: "edit"; id: string }
  | { view: "history"; domain?: string; task?: string }
  | { view: "execution"; executionId: string };

function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/");
  const [head, a, b] = parts;
  const dec = (s?: string) => (s ? decodeURIComponent(s) : undefined);
  if (head === "executions" && a) return { view: "execution", executionId: a };
  if (head === "run" && a) return { view: "run", id: a };
  if (head === "t" && a && b) return { view: "task", domain: dec(a)!, task: dec(b)! };
  if (head === "new") return { view: "new", domain: dec(a), task: dec(b) };
  if (head === "edit" && a) return { view: "edit", id: a };
  if (head === "history") {
    if (a === "t" && b && parts[3]) return { view: "history", domain: dec(b), task: dec(parts[3]) };
    return { view: "history" };
  }
  return { view: "workflows" };
}

const newHash = (domain?: string, task?: string) => {
  if (domain && task) return `#/new/${encodeURIComponent(domain)}/${encodeURIComponent(task)}`;
  if (domain) return `#/new/${encodeURIComponent(domain)}`;
  return "#/new";
};
const taskHash = (domain: string, task: string) =>
  `#/t/${encodeURIComponent(domain)}/${encodeURIComponent(task)}`;
const historyTaskHash = (domain: string, task: string) =>
  `#/history/t/${encodeURIComponent(domain)}/${encodeURIComponent(task)}`;

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

  const inWorkflows = route.view === "workflows" || route.view === "run" || route.view === "task";
  const navHistoryActive = route.view === "history" || route.view === "execution";

  return (
    <div className="app">
      <nav className="topbar">
        <button className="brand" onClick={() => go("#/")}>
          flowwork
        </button>
        <div className="nav-links">
          <button className={inWorkflows ? "active" : ""} onClick={() => go("#/")}>
            워크플로우
          </button>
          <button className={navHistoryActive ? "active" : ""} onClick={() => go("#/history")}>
            워크플로우 이력
          </button>
        </div>
      </nav>

      <main className="content">
        {inWorkflows ? (
          <WorkflowLayout
            title="워크플로우"
            showNew
            activeId={route.view === "run" ? route.id : undefined}
            activeTask={route.view === "task" ? { domain: route.domain, task: route.task } : undefined}
            onOpenTask={(d, t) => go(taskHash(d, t))}
            onNew={(domain, task) => go(newHash(domain, task))}
          >
            {route.view === "run" ? (
              <RunDetail
                id={route.id}
                onOpenExecution={(id) => go(`#/executions/${id}`)}
                onEdit={(i) => go(`#/edit/${i}`)}
              />
            ) : route.view === "task" ? (
              <TaskDetail
                domain={route.domain}
                task={route.task}
                onRun={(i) => go(`#/run/${i}`)}
                onNew={() => go(newHash(route.domain, route.task))}
              />
            ) : (
              <div className="detail-empty">
                <p className="muted">
                  왼쪽에서 업무를 선택하면 해당 업무의 워크플로우가 여기에 표시됩니다.
                </p>
              </div>
            )}
          </WorkflowLayout>
        ) : null}
        {route.view === "new" ? (
          <WorkflowEditor
            mode="new"
            initialDomain={route.domain}
            initialTask={route.task}
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
          <WorkflowLayout
            title="워크플로우 이력"
            activeTask={route.domain && route.task ? { domain: route.domain, task: route.task } : undefined}
            onOpenTask={(d, t) => go(historyTaskHash(d, t))}
            onNew={() => {}}
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
                onOpen={(id) => go(`#/executions/${id}`)}
              />
            </section>
          </WorkflowLayout>
        ) : null}
        {route.view === "execution" ? (
          <WorkflowLayout
            title="워크플로우 이력"
            onOpenTask={(d, t) => go(historyTaskHash(d, t))}
            onNew={() => {}}
          >
            <section className="execution-page">
              <button className="link" onClick={() => go("#/history")}>
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

// 도메인 표시 순서 (미지정 도메인은 이 뒤에 가나다순으로 붙는다)
const GROUP_ORDER = ["계좌", "계정", "매매", "인증", "마케팅", "상품"];

function orderGroups(groups: string[]): string[] {
  const known = GROUP_ORDER.filter((g) => groups.includes(g));
  const rest = groups.filter((g) => !GROUP_ORDER.includes(g)).sort((a, b) => a.localeCompare(b, "ko"));
  return [...known, ...rest];
}

/**
 * 좌측 sticky 사이드바에 [도메인(세로) → 업무(자식 메뉴)] 트리를 고정으로 두고,
 * 우측 detail 영역에 선택한 업무의 워크플로우 목록 / 실행 화면(children)을 보여준다.
 * 자식(업무) 메뉴 왼쪽에는 도메인 전용 색상 불릿을 찍어 도메인을 구분한다.
 */
function WorkflowLayout({
  title = "워크플로우",
  showNew = false,
  activeId,
  activeTask,
  onOpenTask,
  onNew,
  children,
}: {
  title?: string;
  showNew?: boolean;
  activeId?: string;
  activeTask?: { domain: string; task: string };
  onOpenTask: (domain: string, task: string) => void;
  onNew: (domain?: string, task?: string) => void;
  children: ReactNode;
}) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // 펼친 도메인 집합. 여러 도메인을 동시에 열어둘 수 있고, 새 선택이 기존 열림을 닫지 않는다.
  const [openDomains, setOpenDomains] = useState<Set<string>>(() => new Set());
  // 사이드바 크기 조절 / 접기 (localStorage 유지)
  const [sbWidth, setSbWidth] = useState(() => Number(localStorage.getItem("wf-sb-w")) || 280);
  const [sbCollapsed, setSbCollapsed] = useState(() => localStorage.getItem("wf-sb-collapsed") === "1");
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    localStorage.setItem("wf-sb-w", String(sbWidth));
  }, [sbWidth]);
  useEffect(() => {
    localStorage.setItem("wf-sb-collapsed", sbCollapsed ? "1" : "0");
  }, [sbCollapsed]);

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = sbWidth;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: MouseEvent) =>
      setSbWidth(Math.min(460, Math.max(200, startW + ev.clientX - startX)));
    const onUp = () => {
      setResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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

  // 실행 중인 워크플로우가 있으면 그 (도메인,업무)를 강조 대상으로
  const runningWf = useMemo(() => rows?.find((w) => w.id === activeId) ?? null, [rows, activeId]);
  const hlDomain = (activeTask?.domain ?? runningWf?.domain)?.normalize("NFC");
  const hlTask = (activeTask?.task ?? runningWf?.task)?.normalize("NFC");

  // 선택된 업무가 있으면 그 도메인을 (기존에 열린 도메인은 유지한 채) 펼친다
  useEffect(() => {
    if (!hlDomain) return;
    setOpenDomains((cur) => (cur.has(hlDomain) ? cur : new Set(cur).add(hlDomain)));
  }, [hlDomain]);

  // 도메인 → 업무(정렬) 트리
  const tree = useMemo(() => {
    const byDomain = new Map<string, WorkflowSummary[]>();
    for (const d of GROUP_ORDER) byDomain.set(d, []);
    for (const w of rows ?? []) {
      const d = w.domain.normalize("NFC");
      const list = byDomain.get(d) ?? [];
      list.push(w);
      byDomain.set(d, list);
    }
    return orderGroups([...byDomain.keys()]).map((domain) => {
      const items = byDomain.get(domain)!;
      const tasks = [...new Set(items.map((w) => w.task.normalize("NFC")))].sort((a, b) =>
        a.localeCompare(b, "ko"),
      );
      return { domain, tasks };
    });
  }, [rows]);

  if (sbCollapsed) {
    return (
      <div className="workspace">
        <button className="sidebar-reopen" onClick={() => setSbCollapsed(false)} title="메뉴 열기">
          ›
        </button>
        <div className="wf-detail">{children}</div>
      </div>
    );
  }

  return (
    <div className="workspace">
      <aside className="wf-sidebar" style={{ ["--sb-w" as string]: `${sbWidth}px` } as CSSProperties}>
        <div className="sidebar-scroll">
          <div className="sidebar-head">
            <div className="sidebar-title">
              <button className="icon-btn" onClick={() => setSbCollapsed(true)} title="메뉴 닫기">
                ‹
              </button>
              <h2>{title}</h2>
            </div>
            {showNew ? (
              <button className="primary small" onClick={() => onNew(hlDomain)}>
                + 새로
              </button>
            ) : null}
          </div>

          {error ? <div className="error-banner">{error}</div> : null}

          {!rows ? (
            <p className="muted">불러오는 중…</p>
          ) : (
            <nav className="domain-tree">
            {tree.map(({ domain, tasks }) => {
              const color = colorForDomain(domain, colors);
              const open = openDomains.has(domain);
              return (
                <div key={domain} className={`domain-group ${open ? "open" : ""}`}>
                  <button
                    className="domain-head"
                    onClick={() =>
                      setOpenDomains((cur) => {
                        const next = new Set(cur);
                        if (next.has(domain)) next.delete(domain);
                        else next.add(domain);
                        return next;
                      })
                    }
                    aria-expanded={open}
                  >
                    <span className="domain-caret">{open ? "▾" : "▸"}</span>
                    <span className="domain-swatch" style={{ background: color }} />
                    <span className="domain-name">{domain}</span>
                    <span className="domain-count">{tasks.length}</span>
                  </button>
                  {open ? (
                    tasks.length === 0 ? (
                      <div className="task-empty muted">업무 없음</div>
                    ) : (
                      <ul className="task-menu">
                        {tasks.map((task) => {
                          const on = hlDomain === domain && hlTask === task;
                          return (
                            <li key={task}>
                              <button
                                className={`task-item ${on ? "active" : ""}`}
                                onClick={() => onOpenTask(domain, task)}
                              >
                                <span className="task-bullet" style={{ background: color }} />
                                <span className="task-text">{task}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )
                  ) : null}
                </div>
              );
            })}
            </nav>
          )}
        </div>
        <div
          className={`sidebar-resizer ${resizing ? "active" : ""}`}
          onMouseDown={startResize}
          title="드래그하여 크기 조절"
        />
      </aside>

      <div className="wf-detail">{children}</div>
    </div>
  );
}

/** 선택한 업무(도메인/업무) 하위의 모든 워크플로우(작업)를 한 화면에 나열한다. */
function TaskDetail({
  domain,
  task,
  onRun,
  onNew,
}: {
  domain: string;
  task: string;
  onRun: (id: string) => void;
  onNew: () => void;
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
        <button className="primary small" onClick={onNew}>
          + 새 워크플로우
        </button>
      </div>

      {items.length === 0 ? (
        <div className="detail-empty">
          <p className="muted">이 업무에는 아직 워크플로우가 없습니다. "새 워크플로우"로 추가하세요.</p>
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
  onEdit,
}: {
  id: string;
  onOpenExecution: (id: string) => void;
  onEdit: (id: string) => void;
}) {
  const [wf, setWf] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dup, setDup] = useState(false);

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

  // 복제: 같은 (도메인,업무) 안에서 유일한 이름으로 사본을 만들고 편집 화면으로 이동.
  // 스텝 id는 그대로 유지한다 (PREV_RESPONSE 매핑·분기 조건이 스텝 id를 참조).
  async function handleDuplicate() {
    if (!wf) return;
    setDup(true);
    setError(null);
    try {
      const siblings = await api.listWorkflows();
      const taken = new Set(
        siblings
          .filter((s) => s.domain === wf.domain && s.task === wf.task)
          .map((s) => s.name),
      );
      let name = `${wf.name} 복사`;
      for (let n = 2; taken.has(name); n++) name = `${wf.name} 복사 ${n}`;
      const copy: Workflow = { ...wf, id: crypto.randomUUID(), name };
      await api.saveWorkflow(copy);
      onEdit(copy.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDup(false);
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!wf) return <p className="muted">불러오는 중…</p>;
  return (
    <>
      <div className="run-topbar">
        <button className="link" onClick={() => (location.hash = taskHash(wf.domain, wf.task))}>
          ← {wf.domain} / {wf.task}
        </button>
        <div className="run-actions">
          <button className="link" onClick={handleDuplicate} disabled={dup}>
            {dup ? "복제 중…" : "복제"}
          </button>
          <button className="link" onClick={() => onEdit(id)}>
            편집 →
          </button>
        </div>
      </div>
      <WorkflowRunner workflow={wf} onOpenExecution={onOpenExecution} />
    </>
  );
}
