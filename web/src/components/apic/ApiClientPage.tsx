import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { api, type EditFileEntry } from "../../api/client";
import { FILE_STATE_META } from "../edit/EditPage";
import {
  appendItem,
  emptyRequest,
  getItem,
  removeItem,
  updateItem,
  type ApicCollection,
  type ApicCollectionSummary,
  type ApicItem,
  type ApicWorkspace,
} from "../../types/apic";
import { CollectionOverview } from "./CollectionOverview";
import { RequestPanel } from "./RequestPanel";

type SaveState = "idle" | "saving" | "saved" | "error";

function countRequests(items: ApicItem[]): number {
  return items.reduce(
    (n, item) => n + (item.type === "folder" ? countRequests(item.items) : 1),
    0,
  );
}

/**
 * API 콜렉션 화면 — Bruno 스타일 3영역: workspace 선택 → 콜렉션/폴더/요청 트리(좌) →
 * 요청 편집·전송 또는 콜렉션 개요(우). 문서 편집은 디바운스 자동 저장.
 *
 * 워크플로우와 동일한 브랜치 편집 플로우 — 항상 편집 worktree(develop/feature)를
 * 보고, 편집(canEdit)은 수정 모드(feature 브랜치)에서만 활성화된다.
 */
export function ApiClientPage({
  ws,
  onSelectWs,
  canEdit = true,
  collectionStates,
  onChanged,
}: {
  ws?: string;
  onSelectWs: (ws: string | null) => void;
  canEdit?: boolean;
  collectionStates?: Map<string, EditFileEntry>; // 콜렉션 id → 파일 상태 (배지)
  onChanged?: () => void; // 저장/삭제 후 상태 갱신용
}) {
  const [workspaces, setWorkspaces] = useState<ApicWorkspace[] | null>(null);
  const [cols, setCols] = useState<ApicCollectionSummary[] | null>(null);
  const [docs, setDocs] = useState<Record<string, ApicCollection>>({});
  const [openCols, setOpenCols] = useState<Set<string>>(() => new Set());
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const [sel, setSel] = useState<{ cid: string; path?: number[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const fileRef = useRef<HTMLInputElement>(null);

  const docsRef = useRef(docs);
  docsRef.current = docs;
  const timers = useRef<Map<string, number>>(new Map());

  // workspace 목록 로드 (+ 선택이 없으면 첫 workspace로 이동)
  useEffect(() => {
    let alive = true;
    api
      .apicListWorkspaces()
      .then((list) => {
        if (!alive) return;
        setWorkspaces(list);
        if (!ws && list.length > 0) onSelectWs(list[0].name);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws]);

  // workspace 변경 시 콜렉션 목록 로드 & 편집 상태 초기화
  useEffect(() => {
    setCols(null);
    setDocs({});
    setSel(null);
    setOpenCols(new Set());
    setOpenFolders(new Set());
    setError(null);
    if (!ws) return;
    let alive = true;
    api
      .apicListCollections(ws)
      .then((list) => alive && setCols(list))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [ws]);

  async function ensureDoc(cid: string): Promise<ApicCollection | null> {
    if (docsRef.current[cid]) return docsRef.current[cid];
    if (!ws) return null;
    try {
      const doc = await api.apicGetCollection(ws, cid);
      setDocs((cur) => ({ ...cur, [cid]: doc }));
      return doc;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }

  /** 문서 갱신 + 디바운스 저장 + 사이드바 요약(이름/요청 수) 동기화 */
  function mutateDoc(cid: string, update: (doc: ApicCollection) => ApicCollection) {
    if (!canEdit) return; // 읽기 전용(develop) — 수정 모드에서만 편집
    setDocs((cur) => {
      const doc = cur[cid];
      if (!doc) return cur;
      const next = update(doc);
      setCols(
        (list) =>
          list?.map((c) =>
            c.id === cid ? { ...c, name: next.name, request_count: countRequests(next.items) } : c,
          ) ?? list,
      );
      return { ...cur, [cid]: next };
    });
    const prev = timers.current.get(cid);
    if (prev) window.clearTimeout(prev);
    timers.current.set(
      cid,
      window.setTimeout(() => {
        void flushSave(cid);
      }, 700),
    );
  }

  async function flushSave(cid: string) {
    const doc = docsRef.current[cid];
    if (!doc || !ws) return;
    setSaveState("saving");
    try {
      await api.apicSaveCollection(ws, doc);
      setSaveState("saved");
      onChanged?.(); // 브랜치 파일 상태(수정됨 배지 등) 갱신
    } catch (e) {
      setSaveState("error");
      setError(`저장 실패: ${(e as Error).message}`);
    }
  }

  // ---- workspace 액션 ----
  async function createWorkspace() {
    const name = window.prompt("새 workspace 이름");
    if (!name?.trim()) return;
    try {
      await api.apicCreateWorkspace(name.trim());
      setWorkspaces(await api.apicListWorkspaces());
      onSelectWs(name.trim());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteWorkspace() {
    if (!ws) return;
    if (!window.confirm(`workspace '${ws}'와 안의 모든 콜렉션을 삭제할까요?`)) return;
    try {
      await api.apicDeleteWorkspace(ws);
      const list = await api.apicListWorkspaces();
      setWorkspaces(list);
      onSelectWs(list[0]?.name ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---- 콜렉션 액션 ----
  async function createCollection() {
    if (!ws) return;
    const name = window.prompt("새 콜렉션 이름");
    if (!name?.trim()) return;
    try {
      const doc = await api.apicCreateCollection(ws, name.trim());
      setCols(await api.apicListCollections(ws));
      setDocs((cur) => ({ ...cur, [doc.id]: doc }));
      setOpenCols((cur) => new Set(cur).add(doc.id));
      setSel({ cid: doc.id });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function importCollection(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !ws) return;
    try {
      const data: unknown = JSON.parse(await file.text());
      const doc = await api.apicImportCollection(ws, data);
      setCols(await api.apicListCollections(ws));
      setDocs((cur) => ({ ...cur, [doc.id]: doc }));
      setOpenCols((cur) => new Set(cur).add(doc.id));
      setSel({ cid: doc.id });
    } catch (err) {
      setError(
        err instanceof SyntaxError ? `JSON 파일이 아닙니다: ${err.message}` : (err as Error).message,
      );
    }
  }

  const [importing, setImporting] = useState(false);
  const [ghStatus, setGhStatus] = useState<{ logged_in: boolean; login: string | null } | null>(
    null,
  );

  // GitHub 인증 상태 (private 레포 import 가능 여부 안내)
  const refreshGhStatus = () => {
    api
      .apicGithubStatus()
      .then(setGhStatus)
      .catch(() => setGhStatus(null));
  };
  useEffect(refreshGhStatus, []);

  async function importFromGithub() {
    if (!ws) return;
    const url = window.prompt(
      "GitHub 레포 URL (예: https://github.com/geeshow/flowwork-apis)",
    );
    if (!url?.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const imported = await api.apicImportGithub(ws, url.trim());
      setCols(await api.apicListCollections(ws));
      if (imported.length > 0) {
        await ensureDoc(imported[0].id);
        setOpenCols((cur) => new Set(cur).add(imported[0].id));
        setSel({ cid: imported[0].id });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function deleteCollection(cid: string) {
    if (!ws) return;
    try {
      await api.apicDeleteCollection(ws, cid);
      setCols(await api.apicListCollections(ws));
      setDocs(({ [cid]: _, ...rest }) => rest);
      if (sel?.cid === cid) setSel(null);
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleCollection(cid: string) {
    const doc = await ensureDoc(cid);
    if (!doc) return;
    setOpenCols((cur) => {
      const next = new Set(cur);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
    setSel({ cid });
  }

  function addRequest(cid: string, folderPath: number[]) {
    const name = window.prompt("요청 이름");
    if (!name?.trim()) return;
    const child: ApicItem = { type: "http", name: name.trim(), request: emptyRequest() };
    let newPath: number[] = [];
    mutateDoc(cid, (doc) => {
      const parent =
        folderPath.length === 0 ? doc.items : (getItem(doc.items, folderPath) as ApicItem & { items: ApicItem[] })?.items;
      newPath = [...folderPath, parent?.length ?? 0];
      return { ...doc, items: appendItem(doc.items, folderPath, child) };
    });
    setSel({ cid, path: newPath });
  }

  function addFolder(cid: string, folderPath: number[]) {
    const name = window.prompt("폴더 이름");
    if (!name?.trim()) return;
    mutateDoc(cid, (doc) => ({
      ...doc,
      items: appendItem(doc.items, folderPath, { type: "folder", name: name.trim(), items: [] }),
    }));
  }

  function deleteItem(cid: string, path: number[], label: string) {
    if (!window.confirm(`'${label}'을(를) 삭제할까요?`)) return;
    mutateDoc(cid, (doc) => ({ ...doc, items: removeItem(doc.items, path) }));
    // 삭제로 인덱스 경로가 밀리므로, 같은 콜렉션의 선택은 개요로 되돌린다
    if (sel?.cid === cid && sel.path) setSel({ cid });
  }

  function renameFolder(cid: string, path: number[], current: string) {
    const name = window.prompt("폴더 이름", current);
    if (!name?.trim()) return;
    mutateDoc(cid, (doc) => ({
      ...doc,
      items: updateItem(doc.items, path, (item) => ({ ...item, name: name.trim() })),
    }));
  }

  // ---- 트리 렌더링 ----
  function renderItems(cid: string, items: ApicItem[], base: number[]) {
    return (
      <ul className="apic-tree">
        {items.map((item, i) => {
          const path = [...base, i];
          const key = `${cid}:${path.join(".")}`;
          if (item.type === "folder") {
            const open = openFolders.has(key);
            return (
              <li key={key}>
                <div className="apic-row folder">
                  <button
                    className="apic-row-main"
                    onClick={() =>
                      setOpenFolders((cur) => {
                        const next = new Set(cur);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    onDoubleClick={() => renameFolder(cid, path, item.name)}
                    title="더블클릭: 이름 변경"
                  >
                    <span className="domain-caret">{open ? "▾" : "▸"}</span>
                    <span className="apic-row-name">{item.name}</span>
                  </button>
                  {canEdit ? (
                    <span className="apic-row-actions">
                      <button className="icon-btn" title="요청 추가" onClick={() => addRequest(cid, path)}>
                        +
                      </button>
                      <button
                        className="icon-btn danger"
                        title="폴더 삭제"
                        onClick={() => deleteItem(cid, path, item.name)}
                      >
                        ✕
                      </button>
                    </span>
                  ) : null}
                </div>
                {open ? renderItems(cid, item.items, path) : null}
              </li>
            );
          }
          const active =
            sel?.cid === cid && sel.path && sel.path.join(".") === path.join(".");
          return (
            <li key={key}>
              <div className={`apic-row ${active ? "active" : ""}`}>
                <button className="apic-row-main" onClick={() => setSel({ cid, path })}>
                  <span className={`apic-method-tag method-${item.request.method.toLowerCase()}`}>
                    {item.request.method}
                  </span>
                  <span className="apic-row-name">{item.name}</span>
                </button>
                {canEdit ? (
                  <span className="apic-row-actions">
                    <button
                      className="icon-btn danger"
                      title="요청 삭제"
                      onClick={() => deleteItem(cid, path, item.name)}
                    >
                      ✕
                    </button>
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  // ---- 상세(우측) ----
  const selDoc = sel ? docs[sel.cid] : null;
  const selItem = selDoc && sel?.path ? getItem(selDoc.items, sel.path) : null;

  return (
    <div className="workspace">
      <aside className="wf-sidebar">
        <div className="sidebar-scroll">
          <div className="sidebar-head">
            <div className="sidebar-title">
              <h2>API 콜렉션</h2>
            </div>
            <span className={`apic-save-state ${saveState}`}>
              {saveState === "saving" ? "저장 중…" : saveState === "saved" ? "저장됨" : ""}
            </span>
          </div>

          <div className="apic-ws-bar">
            <select value={ws ?? ""} onChange={(e) => onSelectWs(e.target.value || null)}>
              {!ws ? <option value="">workspace 선택</option> : null}
              {(workspaces ?? []).map((w) => (
                <option key={w.name} value={w.name}>
                  {w.name} ({w.collection_count})
                </option>
              ))}
            </select>
            {canEdit ? (
              <>
                <button className="icon-btn" title="workspace 추가" onClick={() => void createWorkspace()}>
                  +
                </button>
                <button
                  className="icon-btn danger"
                  title="workspace 삭제"
                  onClick={() => void deleteWorkspace()}
                  disabled={!ws}
                >
                  ✕
                </button>
              </>
            ) : null}
          </div>

          {!canEdit ? (
            <p className="muted small-text">
              읽기 전용 — 콜렉션을 수정하려면 상단에서 feature 브랜치를 만들어 수정 모드로
              들어가세요.
            </p>
          ) : null}

          {error ? <div className="error-banner">{error}</div> : null}

          {!ws ? (
            workspaces && workspaces.length === 0 ? (
              <p className="muted">
                workspace가 없습니다. 위의 <b>+</b>로 첫 workspace를 만드세요.
              </p>
            ) : null
          ) : (
            <>
              {canEdit ? (
                <div className="apic-col-actions">
                  <button className="link small" onClick={() => void createCollection()}>
                    + 콜렉션
                  </button>
                  <button className="link small" onClick={() => fileRef.current?.click()}>
                    가져오기(JSON)
                  </button>
                  <button
                    className="link small"
                    onClick={() => void importFromGithub()}
                    disabled={importing}
                  >
                    {importing ? "가져오는 중…" : "가져오기(GitHub)"}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={(e) => void importCollection(e)}
                  />
                </div>
              ) : null}

              <div className="apic-gh-status">
                {ghStatus?.logged_in ? (
                  <span className="muted">
                    GitHub: <b>{ghStatus.login ?? "로그인됨"}</b> ✓ (private 레포 가능)
                  </span>
                ) : (
                  <span className="muted">
                    GitHub 미로그인 — private 레포는 터미널에서 <code>gh auth login</code> 후{" "}
                    <button className="link small" onClick={refreshGhStatus}>
                      새로고침
                    </button>
                  </span>
                )}
              </div>

              {!cols ? (
                <p className="muted">불러오는 중…</p>
              ) : cols.length === 0 ? (
                <p className="muted">콜렉션이 없습니다. Bruno/Postman JSON을 가져올 수도 있습니다.</p>
              ) : (
                <nav className="domain-tree">
                  {cols.map((c) => {
                    const open = openCols.has(c.id);
                    const active = sel?.cid === c.id && !sel.path;
                    return (
                      <div key={c.id} className={`domain-group ${open ? "open" : ""}`}>
                        <button
                          className={`domain-head ${active ? "active" : ""}`}
                          onClick={() => void toggleCollection(c.id)}
                          aria-expanded={open}
                        >
                          <span className="domain-caret">{open ? "▾" : "▸"}</span>
                          <span className="domain-name">{c.name}</span>
                          {(() => {
                            const stEntry = collectionStates?.get(c.id);
                            if (!stEntry) return null;
                            const meta = FILE_STATE_META[stEntry.state];
                            return <span className={`state-badge sm ${meta.cls}`}>{meta.label}</span>;
                          })()}
                          <span className="domain-count">{c.request_count}</span>
                        </button>
                        {open && docs[c.id] ? (
                          <div className="apic-tree-root">
                            {renderItems(c.id, docs[c.id].items, [])}
                            {canEdit ? (
                              <div className="apic-tree-add">
                                <button className="link small" onClick={() => addRequest(c.id, [])}>
                                  + 요청
                                </button>
                                <button className="link small" onClick={() => addFolder(c.id, [])}>
                                  + 폴더
                                </button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </nav>
              )}
            </>
          )}
        </div>
      </aside>

      <div className="wf-detail">
        {selDoc && selItem?.type === "http" && sel?.path ? (
          <RequestPanel
            doc={selDoc}
            name={selItem.name}
            request={selItem.request}
            onChangeName={(name) =>
              mutateDoc(sel.cid, (doc) => ({
                ...doc,
                items: updateItem(doc.items, sel.path!, (item) => ({ ...item, name })),
              }))
            }
            onChangeRequest={(request) =>
              mutateDoc(sel.cid, (doc) => ({
                ...doc,
                items: updateItem(doc.items, sel.path!, (item) =>
                  item.type === "http" ? { ...item, request } : item,
                ),
              }))
            }
            onChangeActiveEnv={(envName) =>
              mutateDoc(sel.cid, (doc) => ({ ...doc, activeEnvironment: envName }))
            }
          />
        ) : selDoc && ws ? (
          <CollectionOverview
            ws={ws}
            doc={selDoc}
            canEdit={canEdit}
            onChange={(doc) => mutateDoc(doc.id, () => doc)}
            onDelete={() => void deleteCollection(selDoc.id)}
          />
        ) : (
          <div className="detail-empty">
            <p className="muted">
              왼쪽에서 콜렉션이나 요청을 선택하세요. Bruno처럼 workspace → 콜렉션 → 폴더/요청
              구조로 API를 관리하고 바로 호출할 수 있습니다.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
