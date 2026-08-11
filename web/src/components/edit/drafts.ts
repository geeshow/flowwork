import type { Workflow } from "../../types";

/** 브랜치별 로컬 드래프트 (localStorage).
 *
 * 편집 worktree는 서버 1개를 여러 사용자가 공유하므로, 편집 메뉴 재진입 시
 * worktree는 develop으로 되돌리되(커밋 전 변경은 discard) 그 내용을 브라우저
 * localStorage에 스냅샷해 둔다. 같은 브랜치로 다시 수정 모드에 들어오면
 * 드래프트를 worktree에 복원해 이어서 수정한다. 커밋되면 드래프트를 비운다.
 */
export interface BranchDrafts {
  workflows: Record<string, Workflow>; // id → 수정본
  deleted: string[]; // 삭제한 워크플로우 id
  files: Record<string, string>; // 워크플로우 외 일반 파일 — path → 내용 (domains.json 등)
  savedAt: number;
}

const empty = (): BranchDrafts => ({ workflows: {}, deleted: [], files: {}, savedAt: 0 });

const key = (branch: string) => `fw-drafts:${branch}`;

export function loadDrafts(branch: string): BranchDrafts | null {
  try {
    const raw = localStorage.getItem(key(branch));
    if (!raw) return null;
    const data = JSON.parse(raw) as BranchDrafts;
    if (!data || typeof data !== "object" || !data.workflows) return null;
    return {
      workflows: data.workflows,
      deleted: data.deleted ?? [],
      files: data.files ?? {},
      savedAt: data.savedAt ?? 0,
    };
  } catch {
    return null;
  }
}

function store(branch: string, drafts: BranchDrafts) {
  try {
    localStorage.setItem(key(branch), JSON.stringify(drafts));
  } catch {
    /* 저장소 가득 참 등 — 드래프트는 보조 수단이라 무시 */
  }
}

export function draftCount(d: BranchDrafts | null): number {
  return d ? Object.keys(d.workflows).length + d.deleted.length + Object.keys(d.files).length : 0;
}

export function putDraftWorkflow(branch: string, wf: Workflow) {
  const d = loadDrafts(branch) ?? empty();
  d.workflows[wf.id] = wf;
  d.deleted = d.deleted.filter((id) => id !== wf.id);
  d.savedAt = Date.now();
  store(branch, d);
}

export function putDraftDeletion(branch: string, id: string) {
  const d = loadDrafts(branch) ?? empty();
  delete d.workflows[id];
  if (!d.deleted.includes(id)) d.deleted.push(id);
  d.savedAt = Date.now();
  store(branch, d);
}

export function putDraftFile(branch: string, path: string, content: string) {
  const d = loadDrafts(branch) ?? empty();
  d.files[path] = content;
  d.savedAt = Date.now();
  store(branch, d);
}

export function removeDraft(branch: string, id: string) {
  const d = loadDrafts(branch);
  if (!d) return;
  delete d.workflows[id];
  d.deleted = d.deleted.filter((x) => x !== id);
  store(branch, d);
}

export function clearDrafts(branch: string) {
  try {
    localStorage.removeItem(key(branch));
  } catch {
    /* ignore */
  }
}
