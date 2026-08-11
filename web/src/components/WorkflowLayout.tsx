import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { api, type DataSource, type WorkflowSummary } from "../api/client";
import { colorForDomain } from "../domainPalette";

// 도메인 표시 순서 (미지정 도메인은 이 뒤에 가나다순으로 붙는다)
export const GROUP_ORDER = ["계좌", "계정", "매매", "정산", "인증", "마케팅", "상품"];

export function orderGroups(groups: string[]): string[] {
  const known = GROUP_ORDER.filter((g) => groups.includes(g));
  const rest = groups.filter((g) => !GROUP_ORDER.includes(g)).sort((a, b) => a.localeCompare(b, "ko"));
  return [...known, ...rest];
}

/**
 * 좌측 sticky 사이드바에 [도메인(세로) → 업무(자식 메뉴)] 트리를 고정으로 두고,
 * 우측 detail 영역에 선택한 업무의 워크플로우 목록 / 실행 화면(children)을 보여준다.
 * 자식(업무) 메뉴 왼쪽에는 도메인 전용 색상 불릿을 찍어 도메인을 구분한다.
 *
 * source="edit"이면 편집 worktree(develop/feature 브랜치) 기준 목록을 보여준다.
 * refreshKey가 바뀌면 목록을 다시 불러온다 (브랜치 전환/저장 후 갱신용).
 */
export function WorkflowLayout({
  title = "워크플로우",
  source = "prod",
  refreshKey,
  action,
  activeId,
  activeTask,
  onOpenTask,
  taskBadge,
  children,
}: {
  title?: string;
  source?: DataSource;
  refreshKey?: unknown;
  action?: ReactNode; // 사이드바 헤더 우측 액션 (예: 편집 모드의 "+ 새 워크플로우")
  activeId?: string;
  activeTask?: { domain: string; task: string };
  onOpenTask: (domain: string, task: string) => void;
  taskBadge?: (domain: string, task: string) => ReactNode; // 업무 항목 우측 배지 (편집 상태 표시용)
  children: ReactNode;
}) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  // 펼친 도메인 집합. 여러 도메인을 동시에 열어둘 수 있고, 새 선택이 기존 열림을 닫지 않는다.
  // 라우트 이동(이력/실행 상세 등)으로 레이아웃이 다시 마운트돼도 유지되도록 localStorage에 저장.
  const [openDomains, setOpenDomains] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("wf-open-domains") ?? "[]");
      return new Set(Array.isArray(saved) ? saved.map(String) : []);
    } catch {
      return new Set();
    }
  });
  // 사이드바 크기 조절 / 접기 (localStorage 유지)
  const [sbWidth, setSbWidth] = useState(() => Number(localStorage.getItem("wf-sb-w")) || 280);
  const [sbCollapsed, setSbCollapsed] = useState(() => localStorage.getItem("wf-sb-collapsed") === "1");
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    localStorage.setItem("wf-open-domains", JSON.stringify([...openDomains]));
  }, [openDomains]);
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
    Promise.all([api.listWorkflows(source), api.getDomainColors(source)])
      .then(([r, c]) => {
        if (!alive) return;
        setRows(r);
        setColors(c);
        setError(null);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [source, refreshKey]);

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
            {action}
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
                                {taskBadge?.(domain, task)}
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
