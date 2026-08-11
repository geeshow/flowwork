import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  api,
  type EditFileEntry,
  type EditState,
  type FileState,
  type PendingEntry,
  type WorkflowSummary,
} from "../../api/client";
import { colorForDomain } from "../../domainPalette";
import type { Workflow } from "../../types";
import { WorkflowEditor } from "../editor/WorkflowEditor";
import { WorkflowLayout } from "../WorkflowLayout";
import { WorkflowRunner } from "../WorkflowRunner";
import {
  clearDrafts,
  draftCount,
  loadDrafts,
  putDraftDeletion,
  putDraftFile,
  putDraftWorkflow,
  removeDraft,
} from "./drafts";
import { MergeView } from "./MergeView";

export type EditorPage =
  | { kind: "home" }
  | { kind: "task"; domain: string; task: string }
  | { kind: "run"; id: string }
  | { kind: "new"; domain?: string; task?: string }
  | { kind: "edit"; id: string }
  | { kind: "merge" };

export const FILE_STATE_META: Record<FileState, { label: string; cls: string }> = {
  unstaged: { label: "수정됨", cls: "st-unstaged" },
  staged: { label: "스테이지", cls: "st-staged" },
  committed: { label: "커밋됨", cls: "st-committed" },
  pushed: { label: "푸시됨", cls: "st-pushed" },
};

// 상태 우선순위 (업무 단위 집계 시 가장 앞선 것 표시)
const STATE_PRIORITY: FileState[] = ["unstaged", "staged", "committed", "pushed"];

const CHANGE_LABEL: Record<string, string> = { A: "추가", M: "수정", D: "삭제" };

const branchPath = (branch?: string | null) =>
  branch ? `/editor/b/${encodeURIComponent(branch)}` : "/editor";

/**
 * 편집 메뉴 — 편집 worktree(develop/feature 브랜치)의 워크플로우를 다룬다.
 *
 * - 수정 모드 브랜치는 URL에 담는다: /editor/b/{branch}/… (없으면 develop 기본)
 * - 편집 메뉴 재진입(/editor) 시 서버 worktree를 develop으로 되돌린다. 이때 커밋 전
 *   변경은 브라우저 localStorage 드래프트로 스냅샷 → 같은 브랜치로 다시 들어오면 복원
 * - 파일 상태: develop 대비 수정됨(unstaged) → 스테이지 → 커밋됨 → 푸시됨
 * - develop 머지(충돌 시 해결 화면), develop → master 운영 반영, 운영 미반영 목록
 */
export function EditPage({
  page,
  branch,
  go,
}: {
  page: EditorPage;
  branch?: string;
  go: (path: string) => void;
}) {
  const [st, setSt] = useState<EditState | null>(null);
  const [files, setFiles] = useState<EditFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const bump = useCallback(() => setRefresh((n) => n + 1), []);
  const reconciling = useRef(false);

  const urlBranch = branch ?? null; // null = develop 기본
  const bp = branchPath(urlBranch);

  useEffect(() => {
    let alive = true;
    Promise.all([api.editState(), api.editStatus()])
      .then(([s, f]) => {
        if (!alive) return;
        setSt(s);
        setFiles(f.files);
        setError(null);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [refresh]);

  // ---- 서버 worktree 브랜치를 URL과 일치시킨다 -----------------------------
  // URL에 브랜치가 없으면 develop으로 복귀. 이때 커밋 전 변경은 드래프트로 보관.
  useEffect(() => {
    if (!st || reconciling.current || st.in_merge) return;
    const want = urlBranch ?? st.base_branch;

    async function snapshotAndReset(cur: string) {
      const status = await api.editStatus();
      const pending = status.files.filter((f) => f.state === "unstaged" || f.state === "staged");
      for (const f of pending) {
        if (f.kind === "workflow" && f.id) {
          if (f.change === "D") putDraftDeletion(cur, f.id);
          else putDraftWorkflow(cur, await api.getWorkflow(f.id, "edit"));
        } else if (f.change !== "D") {
          // 워크플로우 외 일반 파일(domains.json 등)은 원문 그대로 보관
          const { content } = await api.editReadFile(f.path);
          if (content != null) putDraftFile(cur, f.path, content);
        }
      }
      await api.editDiscardAll();
      if (pending.length)
        setNotice(
          `'${cur}'의 커밋 전 수정 ${pending.length}건을 이 브라우저에 보관했습니다. ` +
            `해당 브랜치로 다시 들어가면 이어서 수정할 수 있습니다.`,
        );
    }

    async function restoreDrafts(target: string) {
      const d = loadDrafts(target);
      if (!d || draftCount(d) === 0) return;
      for (const wf of Object.values(d.workflows)) await api.saveWorkflow(wf);
      for (const id of d.deleted) await api.deleteWorkflow(id).catch(() => {});
      for (const [path, content] of Object.entries(d.files)) await api.editWriteFile(path, content);
      // 복원해도 worktree가 그대로면(이미 커밋된 내용) 드래프트는 소진된 것 — 비운다
      const after = await api.editState();
      if (!after.dirty) {
        clearDrafts(target);
        return;
      }
      setNotice(`이 브라우저에 보관된 수정 ${draftCount(d)}건을 복원했습니다.`);
    }

    async function reconcile() {
      reconciling.current = true;
      try {
        if (st!.current_branch !== want) {
          if (st!.dirty) await snapshotAndReset(st!.current_branch);
          await api.editCheckout(want);
          if (want !== st!.base_branch) await restoreDrafts(want);
        } else if (want !== st!.base_branch && !st!.dirty) {
          // 브랜치는 맞지만 worktree가 깨끗한 경우(다른 세션이 초기화) — 드래프트 복원
          await restoreDrafts(want);
        } else {
          return; // 일치 — 할 일 없음
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        reconciling.current = false;
      }
      bump();
    }

    const clean = st.current_branch === want && (want === st.base_branch || st.dirty || draftCount(loadDrafts(want)) === 0);
    if (!clean) void reconcile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, urlBranch]);

  const isFeature = !!st && st.current_branch !== st.base_branch && st.current_branch !== st.prod_branch;
  const branchMatched = !!st && st.current_branch === (urlBranch ?? st.base_branch);
  const canEdit = isFeature && branchMatched && !!st && !st.in_merge;

  const statusById = useMemo(() => {
    const map = new Map<string, EditFileEntry>();
    for (const f of files) if (f.kind === "workflow" && f.id) map.set(f.id, f);
    return map;
  }, [files]);

  // 업무(도메인/업무)별 집계 상태 — 사이드바 업무 배지 (가장 앞선 상태 + 건수)
  const taskStates = useMemo(() => {
    const map = new Map<string, { state: FileState; count: number }>();
    for (const f of files) {
      if (f.kind !== "workflow" || !f.domain || !f.task) continue;
      const key = `${f.domain.normalize("NFC")}/${f.task.normalize("NFC")}`;
      const cur = map.get(key);
      if (!cur) map.set(key, { state: f.state, count: 1 });
      else {
        cur.count += 1;
        if (STATE_PRIORITY.indexOf(f.state) < STATE_PRIORITY.indexOf(cur.state)) cur.state = f.state;
      }
    }
    return map;
  }, [files]);

  // 도메인별 변경 여부 — 사이드바 도메인(상위 메뉴)의 노란 점
  const changedDomains = useMemo(() => {
    const set = new Set<string>();
    for (const f of files)
      if (f.kind === "workflow" && f.domain) set.add(f.domain.normalize("NFC"));
    return set;
  }, [files]);

  async function run(op: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await op();
      if (done) setNotice(done);
      bump();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (page.kind === "merge") {
    return (
      <div className="edit-shell">
        <EditBar st={st} files={files} go={go} onAction={run} page={page} urlBranch={urlBranch} />
        {error ? <div className="error-banner">{error}</div> : null}
        <MergeView
          onDone={() => {
            bump();
            go("/editor");
          }}
        />
      </div>
    );
  }

  // 편집기(등록/수정)는 레이아웃 없이 전체 폭 사용
  if (page.kind === "new" || page.kind === "edit") {
    if (st && !canEdit) {
      return (
        <div className="edit-shell">
          <EditBar st={st} files={files} go={go} onAction={run} page={page} urlBranch={urlBranch} />
          <div className="detail-empty">
            <p className="muted">
              워크플로우 등록/수정은 수정 모드(feature 브랜치)에서만 할 수 있습니다. 상단에서
              feature 브랜치를 만들거나 선택하세요.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className="edit-shell">
        <EditBar st={st} files={files} go={go} onAction={run} page={page} urlBranch={urlBranch} />
        {error ? <div className="error-banner">{error}</div> : null}
        <WorkflowEditor
          mode={page.kind}
          id={page.kind === "edit" ? page.id : undefined}
          initialDomain={page.kind === "new" ? page.domain : undefined}
          initialTask={page.kind === "new" ? page.task : undefined}
          onSavedWorkflow={(wf) => {
            if (urlBranch) putDraftWorkflow(urlBranch, wf);
          }}
          onSaved={(i) => {
            bump();
            go(`${bp}/run/${i}`);
          }}
          onCancel={() => go(bp)}
        />
      </div>
    );
  }

  return (
    <div className="edit-shell">
      <EditBar st={st} files={files} go={go} onAction={run} page={page} urlBranch={urlBranch} />
      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="notice-banner">{notice}</div> : null}
      <WorkflowLayout
        title="편집"
        source="edit"
        refreshKey={`${refresh}:${st?.current_branch ?? ""}`}
        activeId={page.kind === "run" ? page.id : undefined}
        activeTask={page.kind === "task" ? { domain: page.domain, task: page.task } : undefined}
        onOpenTask={(d, t) => go(`${bp}/t/${encodeURIComponent(d)}/${encodeURIComponent(t)}`)}
        action={
          canEdit ? (
            <button className="primary small" onClick={() => go(`${bp}/new`)}>
              + 새로
            </button>
          ) : undefined
        }
        taskBadge={(domain, task) => {
          const ts = taskStates.get(`${domain}/${task}`);
          if (!ts) return null;
          const meta = FILE_STATE_META[ts.state];
          return (
            <span className={`state-badge sm ${meta.cls}`}>
              {meta.label}
              {ts.count > 1 ? ` ${ts.count}` : ""}
            </span>
          );
        }}
        domainBadge={(domain) =>
          changedDomains.has(domain) ? <span className="domain-dot-changed" title="하위 변경 있음" /> : null
        }
      >
        {page.kind === "task" ? (
          <EditTaskDetail
            domain={page.domain}
            task={page.task}
            canEdit={canEdit}
            statusById={statusById}
            refreshKey={`${refresh}:${st?.current_branch ?? ""}`}
            onRun={(i) => go(`${bp}/run/${i}`)}
            onEdit={(i) => go(`${bp}/edit/${i}`)}
            onNew={() => go(`${bp}/new/${encodeURIComponent(page.domain)}/${encodeURIComponent(page.task)}`)}
            onDeleted={(w) => {
              if (urlBranch) putDraftDeletion(urlBranch, w.id);
              bump();
            }}
          />
        ) : page.kind === "run" ? (
          <EditRunDetail
            id={page.id}
            canEdit={canEdit}
            statusById={statusById}
            refreshKey={`${refresh}:${st?.current_branch ?? ""}`}
            onEdit={(i) => go(`${bp}/edit/${i}`)}
            onBack={(d, t) => go(`${bp}/t/${encodeURIComponent(d)}/${encodeURIComponent(t)}`)}
            onOpenExecution={(i) => go(`/executions/${i}`)}
          />
        ) : (
          <EditHome
            st={st}
            files={files}
            isFeature={isFeature}
            onAction={run}
            refreshKey={refresh}
            urlBranch={urlBranch}
          />
        )}
      </WorkflowLayout>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 상단 브랜치/작업 바
// ---------------------------------------------------------------------------
function EditBar({
  st,
  files,
  go,
  onAction,
  page,
  urlBranch,
}: {
  st: EditState | null;
  files: EditFileEntry[];
  go: (path: string) => void;
  onAction: (op: () => Promise<unknown>, done?: string) => Promise<void>;
  page: EditorPage;
  urlBranch: string | null;
}) {
  const [newBranch, setNewBranch] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);

  if (!st) return <div className="edit-bar"><span className="muted">편집 상태 불러오는 중…</span></div>;

  const isFeature = st.current_branch !== st.base_branch && st.current_branch !== st.prod_branch;
  const uncommitted = files.filter((f) => f.state === "unstaged" || f.state === "staged").length;
  const unmergedCommits = files.filter((f) => f.state === "committed" || f.state === "pushed").length;

  const wrap = (op: () => Promise<unknown>, done?: string) => async () => {
    setBusy(true);
    try {
      await onAction(op, done);
    } finally {
      setBusy(false);
    }
  };

  const doMerge = wrap(async () => {
    const branch = st.current_branch;
    const r = await api.editMerge();
    if (r.status === "conflict") {
      go("/editor/merge");
    } else {
      clearDrafts(branch); // 머지 완료 — 이 브랜치 드래프트 폐기
      go("/editor");
    }
  });

  return (
    <div className="edit-bar">
      <div className="edit-bar-left">
        <span className={`branch-chip ${isFeature ? "feature" : "base"}`}>
          {st.current_branch}
          {isFeature ? " (수정 모드)" : " (읽기 전용)"}
        </span>
        <select
          value={urlBranch ?? st.base_branch}
          disabled={busy || st.in_merge}
          onChange={(e) => {
            const v = e.target.value;
            go(v === st.base_branch ? "/editor" : branchPath(v));
          }}
          title="브랜치 전환 (URL에 반영)"
        >
          <option value={st.base_branch}>{st.base_branch}</option>
          {st.feature_branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
          {urlBranch && !st.feature_branches.includes(urlBranch) && urlBranch !== st.base_branch ? (
            <option value={urlBranch}>{urlBranch}</option>
          ) : null}
        </select>

        {!isFeature && !st.in_merge ? (
          <span className="edit-newbranch">
            <input
              placeholder="새 feature 브랜치 이름"
              value={newBranch}
              onChange={(e) => setNewBranch(e.target.value)}
            />
            <button
              className="primary small"
              disabled={busy || !newBranch.trim()}
              onClick={wrap(async () => {
                const r = await api.editCreateBranch(newBranch.trim());
                setNewBranch("");
                go(branchPath(r.branch)); // 수정 모드 진입 — 브랜치를 URL에 반영
              })}
            >
              수정 모드 시작
            </button>
          </span>
        ) : null}
      </div>

      <div className="edit-bar-right">
        {st.in_merge ? (
          <>
            <span className="merge-warn">⚠ 머지 충돌 해결 필요</span>
            {page.kind !== "merge" ? (
              <button className="primary small" onClick={() => go("/editor/merge")}>
                충돌 해결 →
              </button>
            ) : null}
          </>
        ) : isFeature ? (
          <>
            <span className="muted">
              변경 {uncommitted}건 · 커밋됨 {unmergedCommits}건
            </span>
            {commitOpen ? (
              <span className="edit-commit-form">
                <input
                  placeholder="커밋 메시지"
                  value={commitMsg}
                  autoFocus
                  onChange={(e) => setCommitMsg(e.target.value)}
                />
                <button
                  className="primary small"
                  disabled={busy || !commitMsg.trim()}
                  onClick={wrap(async () => {
                    await api.editCommit(commitMsg.trim(), true);
                    clearDrafts(st.current_branch); // 커밋됨 — 드래프트는 역할 종료
                    setCommitMsg("");
                    setCommitOpen(false);
                  }, "커밋했습니다")}
                >
                  커밋
                </button>
                <button className="link" onClick={() => setCommitOpen(false)}>
                  취소
                </button>
              </span>
            ) : (
              <button
                className="small"
                disabled={busy || uncommitted === 0}
                onClick={() => setCommitOpen(true)}
                title="변경 전체를 스테이지하고 커밋"
              >
                커밋…
              </button>
            )}
            <button className="small" disabled={busy} onClick={wrap(() => api.editPush(), "푸시했습니다")}>
              푸시
            </button>
            <button
              className="primary small"
              disabled={busy || uncommitted > 0 || unmergedCommits === 0}
              title={uncommitted > 0 ? "커밋되지 않은 변경이 있습니다" : `${st.base_branch}에 머지`}
              onClick={doMerge}
            >
              {st.base_branch}에 머지
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 홈: 변경 파일 패널 + 운영(master) 미반영 목록 + 운영 반영
// ---------------------------------------------------------------------------
function EditHome({
  st,
  files,
  isFeature,
  onAction,
  refreshKey,
  urlBranch,
}: {
  st: EditState | null;
  files: EditFileEntry[];
  isFeature: boolean;
  onAction: (op: () => Promise<unknown>, done?: string) => Promise<void>;
  refreshKey: unknown;
  urlBranch: string | null;
}) {
  const [pending, setPending] = useState<PendingEntry[] | null>(null);
  const [pendingErr, setPendingErr] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .editPending()
      .then((r) => alive && setPending(r.files))
      .catch((e) => alive && setPendingErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  return (
    <section className="edit-home">
      {isFeature ? (
        <div className="panel">
          <h3>
            변경 사항 <span className="hint">({st?.base_branch} 대비 · {files.length}건)</span>
          </h3>
          {files.length === 0 ? (
            <p className="muted">변경이 없습니다. 왼쪽 메뉴에서 워크플로우를 수정하거나 새로 만드세요.</p>
          ) : (
            <div className="edit-file-list">
              {files.map((f) => (
                <div key={f.path} className="edit-file-row">
                  <span className={`change-badge change-${f.change.toLowerCase()}`}>
                    {CHANGE_LABEL[f.change] ?? f.change}
                  </span>
                  <span className="edit-file-name">
                    {f.kind === "workflow" ? (
                      <>
                        <strong>{f.name}</strong>
                        <span className="muted"> — {f.domain} / {f.task}</span>
                      </>
                    ) : (
                      <code>{f.path}</code>
                    )}
                  </span>
                  <span className={`state-badge ${FILE_STATE_META[f.state].cls}`}>
                    {FILE_STATE_META[f.state].label}
                  </span>
                  <span className="edit-file-actions">
                    {f.state === "unstaged" ? (
                      <>
                        <button className="link" onClick={() => void onAction(() => api.editStage([f.path]))}>
                          스테이지
                        </button>
                        <button
                          className="link danger"
                          onClick={() => {
                            if (confirm(`'${f.name ?? f.path}' 변경을 되돌릴까요? 임시 저장이 사라집니다.`)) {
                              if (urlBranch && f.kind === "workflow" && f.id) removeDraft(urlBranch, f.id);
                              void onAction(() => api.editDiscard([f.path]));
                            }
                          }}
                        >
                          되돌리기
                        </button>
                      </>
                    ) : f.state === "staged" ? (
                      <button className="link" onClick={() => void onAction(() => api.editUnstage([f.path]))}>
                        스테이지 해제
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="panel">
          <h3>수정 모드</h3>
          <p className="muted">
            현재 {st?.base_branch} 브랜치(읽기 전용)를 보고 있습니다. 워크플로우를 등록/수정하려면 상단에서
            feature 브랜치를 만들어 수정 모드로 들어가세요. 수정 완료 후 커밋 → {st?.base_branch} 머지로
            반영합니다.
          </p>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h3>
            운영 미반영 <span className="hint">({st?.prod_branch ?? "master"} 대비 {st?.base_branch ?? "develop"}의 변경)</span>
          </h3>
          {pending && pending.length > 0 && !isFeature && !st?.in_merge ? (
            <button
              className="primary small"
              disabled={releasing}
              onClick={() => {
                if (!confirm(`${st?.base_branch}의 변경 ${pending.length}건을 운영(${st?.prod_branch})에 반영할까요?`))
                  return;
                setReleasing(true);
                void onAction(() => api.editRelease(), "운영에 반영했습니다 (master 병합 + push)").finally(() =>
                  setReleasing(false),
                );
              }}
            >
              {releasing ? "반영 중…" : `운영 반영 (${st?.base_branch} → ${st?.prod_branch})`}
            </button>
          ) : null}
        </div>
        {pendingErr ? <div className="error-banner">{pendingErr}</div> : null}
        {!pending ? (
          <p className="muted">불러오는 중…</p>
        ) : pending.length === 0 ? (
          <p className="muted">모든 변경이 운영({st?.prod_branch})에 반영되어 있습니다.</p>
        ) : (
          <div className="edit-file-list">
            {pending.map((f) => (
              <div key={f.path} className="edit-file-row">
                <span className={`change-badge change-${f.change.toLowerCase()}`}>
                  {CHANGE_LABEL[f.change] ?? f.change}
                </span>
                <span className="edit-file-name">
                  {f.kind === "workflow" ? (
                    <>
                      <strong>{f.name}</strong>
                      <span className="muted"> — {f.domain} / {f.task}</span>
                    </>
                  ) : (
                    <code>{f.path}</code>
                  )}
                </span>
                <span className="muted small-text">{f.path}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 업무 상세 (편집): 워크플로우 카드 + 상태 배지 + 실행/수정/삭제
// ---------------------------------------------------------------------------
function EditTaskDetail({
  domain,
  task,
  canEdit,
  statusById,
  refreshKey,
  onRun,
  onEdit,
  onNew,
  onDeleted,
}: {
  domain: string;
  task: string;
  canEdit: boolean;
  statusById: Map<string, EditFileEntry>;
  refreshKey: unknown;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
  onDeleted: (w: WorkflowSummary) => void;
}) {
  const [rows, setRows] = useState<WorkflowSummary[] | null>(null);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api.listWorkflows("edit"), api.getDomainColors("edit")])
      .then(([r, c]) => {
        if (!alive) return;
        setRows(r);
        setColors(c);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <p className="muted">불러오는 중…</p>;

  const color = colorForDomain(domain.normalize("NFC"), colors);
  const items = rows.filter(
    (w) =>
      w.domain.normalize("NFC") === domain.normalize("NFC") &&
      w.task.normalize("NFC") === task.normalize("NFC"),
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
        {canEdit ? (
          <button className="primary small" onClick={onNew}>
            + 새 워크플로우
          </button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="detail-empty">
          <p className="muted">
            이 업무에는 워크플로우가 없습니다.
            {canEdit ? ' "새 워크플로우"로 추가하세요.' : " 수정 모드에서 추가할 수 있습니다."}
          </p>
        </div>
      ) : (
        <div className="wf-card-grid">
          {items.map((w) => {
            const stEntry = statusById.get(w.id);
            return (
              <div key={w.id} className="wf-card wf-card-edit" style={{ borderLeftColor: color }}>
                <button className="wf-card-body" onClick={() => onRun(w.id)}>
                  <span className="wf-card-title">
                    <span className="task-bullet" style={{ background: color }} />
                    {w.name}
                    {stEntry ? (
                      <span className={`state-badge ${FILE_STATE_META[stEntry.state].cls}`}>
                        {FILE_STATE_META[stEntry.state].label}
                      </span>
                    ) : null}
                  </span>
                  {w.description ? <span className="muted">{w.description}</span> : null}
                </button>
                {canEdit ? (
                  <div className="wf-card-actions">
                    <button className="link" onClick={() => onEdit(w.id)}>
                      수정
                    </button>
                    <button
                      className="link danger"
                      onClick={() => {
                        if (confirm(`'${w.name}' 워크플로우를 삭제할까요? (커밋 전까지는 되돌릴 수 있습니다)`))
                          api
                            .deleteWorkflow(w.id)
                            .then(() => onDeleted(w))
                            .catch((e) => setError((e as Error).message));
                      }}
                    >
                      삭제
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 실행 상세 (편집): 편집 worktree 기준 실행 — 커밋 전 임시 저장 내용으로 동작 확인
// ---------------------------------------------------------------------------
function EditRunDetail({
  id,
  canEdit,
  statusById,
  refreshKey,
  onEdit,
  onBack,
  onOpenExecution,
}: {
  id: string;
  canEdit: boolean;
  statusById: Map<string, EditFileEntry>;
  refreshKey: unknown;
  onEdit: (id: string) => void;
  onBack: (domain: string, task: string) => void;
  onOpenExecution: (id: string) => void;
}) {
  const [wf, setWf] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setWf(null);
    setError(null);
    api
      .getWorkflow(id, "edit")
      .then((w) => alive && setWf(w))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [id, refreshKey]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!wf) return <p className="muted">불러오는 중…</p>;

  const stEntry = statusById.get(wf.id);
  return (
    <>
      <div className="run-topbar">
        <button className="link" onClick={() => onBack(wf.domain, wf.task)}>
          ← {wf.domain} / {wf.task}
        </button>
        <div className="run-actions">
          {stEntry ? (
            <span className={`state-badge ${FILE_STATE_META[stEntry.state].cls}`}>
              {FILE_STATE_META[stEntry.state].label}
            </span>
          ) : null}
          {canEdit ? (
            <button className="link" onClick={() => onEdit(id)}>
              수정 →
            </button>
          ) : null}
        </div>
      </div>
      <WorkflowRunner workflow={wf} source="edit" onOpenExecution={onOpenExecution} />
    </>
  );
}
