import type {
  CatalogEntry,
  EnvironmentValues,
  ResolvedRequest,
  Workflow,
} from "../types";
import type {
  ApicCollection,
  ApicCollectionSummary,
  ApicWorkspace,
} from "../types/apic";
import type { ProxyResult } from "../engine/runWorkflow";

async function req<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

export interface WorkflowSummary {
  id: string;
  domain: string;
  task: string;
  name: string;
  description?: string;
}

// 데이터 소스: prod(운영 master 트리) | edit(브랜치별 편집 worktree)
export type DataSource = "prod" | "edit";

// 현재 편집 중인 브랜치 (EditPage가 URL 브랜치로 설정; null = develop).
// 브랜치마다 전용 worktree가 있어 edit 소스 요청에 branch를 함께 보낸다.
let editBranch: string | null = null;

export function setEditBranch(branch: string | null) {
  editBranch = branch;
}

const src = (source?: DataSource) => {
  if (source !== "edit") return "";
  const qs = new URLSearchParams({ source: "edit" });
  if (editBranch) qs.set("branch", editBranch);
  return `?${qs.toString()}`;
};

const withBranch = (body: Record<string, unknown>) => ({ ...body, branch: editBranch });

// ---- 편집(git) 타입 ----
export interface EditState {
  branch: string;
  base_branch: string;
  prod_branch: string;
  feature_branches: string[];
  dirty: boolean;
  in_merge: boolean;
}

export type FileState = "unstaged" | "staged" | "committed" | "pushed";

export interface EditFileEntry {
  path: string;
  kind: "workflow" | "file";
  state: FileState;
  change: "A" | "M" | "D";
  id?: string;
  domain?: string;
  task?: string;
  name?: string;
}

export interface PendingEntry {
  path: string;
  kind: "workflow" | "file";
  change: "A" | "M" | "D";
  id?: string;
  domain?: string;
  task?: string;
  name?: string;
}

export interface ConflictFile {
  path: string;
  kind: "workflow" | "file";
  id?: string;
  domain?: string;
  task?: string;
  name?: string;
  base: string | null;
  ours: string | null; // develop 쪽
  theirs: string | null; // feature 쪽
  merged: string | null; // 충돌 마커 포함 현재 내용
}

export interface MergeResult {
  status: "merged" | "conflict";
  source_branch?: string;
  pushed?: boolean;
  branch_removed?: boolean;
  files?: string[];
}

export interface ExecutionSummary {
  execution_id: string;
  step_count: number;
  overall_status: "SUCCESS" | "FAILED";
  started_at?: number;
  workflow_id?: string;
}

export const api = {
  listWorkflows: (source?: DataSource) =>
    req<{ workflows: WorkflowSummary[] }>(`/api/workflows${src(source)}`).then(
      (r) => r.workflows,
    ),

  getWorkflow: (id: string, source?: DataSource) =>
    req<Workflow>(`/api/workflows/${id}${src(source)}`),

  // 등록/수정/삭제는 편집 worktree에서만 가능 (서버가 prod 쓰기를 403으로 거부)
  saveWorkflow: (wf: Workflow) =>
    req<{ status: string }>(`/api/workflows/${wf.id}${src("edit")}`, {
      method: "PUT",
      body: JSON.stringify(wf),
    }),

  deleteWorkflow: (id: string) =>
    req<{ status: string }>(`/api/workflows/${id}${src("edit")}`, { method: "DELETE" }),

  searchCatalog: (q = "") =>
    req<{ results: CatalogEntry[]; catalog_version: string | null }>(
      `/api/catalog/search?q=${encodeURIComponent(q)}`,
    ),

  getEnvironments: () =>
    req<{ values: EnvironmentValues }>("/api/catalog/environments").then((r) => r.values),

  // 도메인 → 팔레트 색상 id 매핑
  getDomainColors: (source?: DataSource) =>
    req<{ colors: Record<string, string> }>(`/api/domains${src(source)}`).then((r) => r.colors),

  setDomainColor: (domain: string, color: string) =>
    req<{ status: string }>(`/api/domains/${encodeURIComponent(domain)}${src("edit")}`, {
      method: "PUT",
      body: JSON.stringify({ color }),
    }),

  // ---- 편집(git) — 브랜치별 worktree의 상태/커밋/머지/충돌 ----
  editState: () =>
    req<EditState>(`/api/edit/state${editBranch ? `?branch=${encodeURIComponent(editBranch)}` : ""}`),

  editStatus: () =>
    req<{ branch: string; files: EditFileEntry[] }>(
      `/api/edit/status${editBranch ? `?branch=${encodeURIComponent(editBranch)}` : ""}`,
    ),

  editCreateBranch: (name: string) =>
    req<{ branch: string }>("/api/edit/branches", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  editStage: (paths?: string[]) =>
    req<{ status: string }>("/api/edit/stage", {
      method: "POST",
      body: JSON.stringify(withBranch({ paths: paths ?? null })),
    }),

  editUnstage: (paths?: string[]) =>
    req<{ status: string }>("/api/edit/unstage", {
      method: "POST",
      body: JSON.stringify(withBranch({ paths: paths ?? null })),
    }),

  editDiscard: (paths: string[]) =>
    req<{ status: string }>("/api/edit/discard", {
      method: "POST",
      body: JSON.stringify(withBranch({ paths })),
    }),

  editCommit: (message: string, stageAll = true) =>
    req<{ commit: string }>("/api/edit/commit", {
      method: "POST",
      body: JSON.stringify(withBranch({ message, stage_all: stageAll })),
    }),

  editPush: () =>
    req<{ branch: string; pushed: boolean }>("/api/edit/push", {
      method: "POST",
      body: JSON.stringify(withBranch({})),
    }),

  // 현재 브랜치(worktree)를 develop에 머지 — 완료 시 브랜치/worktree 정리
  editMerge: () =>
    req<MergeResult>("/api/edit/merge", {
      method: "POST",
      body: JSON.stringify({ branch: editBranch }),
    }),

  editConflicts: () =>
    req<{ in_merge: boolean; source_branch: string | null; files: ConflictFile[] }>(
      "/api/edit/conflicts",
    ),

  editResolveConflict: (path: string, content: string) =>
    req<{ status: string }>("/api/edit/conflicts/resolve", {
      method: "POST",
      body: JSON.stringify({ path, content }),
    }),

  editMergeContinue: () =>
    req<{ status: string; pushed: boolean }>("/api/edit/merge/continue", { method: "POST" }),

  editMergeAbort: () => req<{ status: string }>("/api/edit/merge/abort", { method: "POST" }),

  editPending: () =>
    req<{ prod_branch: string; base_branch: string; files: PendingEntry[] }>("/api/edit/pending"),

  // develop → master(운영) 병합 + push
  editRelease: () =>
    req<{ status: string; commit: string; pushed: boolean }>("/api/edit/release", {
      method: "POST",
    }),

  listExecutions: () =>
    req<{ executions: ExecutionSummary[] }>("/api/executions").then((r) => r.executions),

  getExecution: (id: string) =>
    req<{ execution_id: string; steps: unknown[] }>(`/api/executions/${id}`),

  // 실행에 사용된 입력값을 이력에 기록 (서버가 비밀번호 등 리댁션)
  recordExecutionInputs: (id: string, values: Record<string, unknown>, workflow_id?: string) =>
    req<{ status: string }>(`/api/executions/${id}/inputs`, {
      method: "POST",
      body: JSON.stringify({ values, workflow_id }),
    }),

  // 실행 이력에 남기지 않는 보조 호출 (API_COMBO 옵션 조회 / DEPENDENT_LOOKUP)
  invoke: (request: ResolvedRequest): Promise<ProxyResult> =>
    req<ProxyResult>("/api/proxy", {
      method: "POST",
      body: JSON.stringify({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body ?? null,
      }),
    }),

  // ---- API 콜렉션 (Bruno 스타일 workspace/collection) ----
  apicListWorkspaces: () =>
    req<{ workspaces: ApicWorkspace[] }>("/api/apic/workspaces").then((r) => r.workspaces),

  apicCreateWorkspace: (name: string) =>
    req<{ status: string }>("/api/apic/workspaces", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  apicDeleteWorkspace: (ws: string) =>
    req<{ status: string }>(`/api/apic/workspaces/${encodeURIComponent(ws)}`, {
      method: "DELETE",
    }),

  apicListCollections: (ws: string) =>
    req<{ collections: ApicCollectionSummary[] }>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections`,
    ).then((r) => r.collections),

  apicCreateCollection: (ws: string, name: string) =>
    req<ApicCollection>(`/api/apic/workspaces/${encodeURIComponent(ws)}/collections`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  apicGetCollection: (ws: string, id: string) =>
    req<ApicCollection>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections/${encodeURIComponent(id)}`,
    ),

  apicSaveCollection: (ws: string, doc: ApicCollection) =>
    req<{ status: string }>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections/${encodeURIComponent(doc.id)}`,
      { method: "PUT", body: JSON.stringify(doc) },
    ),

  apicDeleteCollection: (ws: string, id: string) =>
    req<{ status: string }>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  apicImportCollection: (ws: string, data: unknown) =>
    req<ApicCollection>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections/import`,
      { method: "POST", body: JSON.stringify(data) },
    ),

  // GitHub 연결 콜렉션을 레포 최신 내용으로 갱신 (id 유지 → 워크플로우 참조 보존)
  apicSyncCollection: (ws: string, id: string) =>
    req<ApicCollection>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections/${encodeURIComponent(id)}/sync`,
      { method: "POST" },
    ),

  // GitHub 인증 상태 (서버의 gh CLI / GITHUB_TOKEN env) — private 레포 import용
  apicGithubStatus: () =>
    req<{ logged_in: boolean; login: string | null }>("/api/apic/github/status"),

  // GitHub 레포에서 Bruno/Postman 콜렉션 일괄 가져오기
  apicImportGithub: (ws: string, url: string) =>
    req<{ imported: ApicCollectionSummary[] }>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections/import-github`,
      { method: "POST", body: JSON.stringify({ url }) },
    ).then((r) => r.imported),

  apicExportCollection: (ws: string, id: string, format: "bruno" | "postman") =>
    req<Record<string, unknown>>(
      `/api/apic/workspaces/${encodeURIComponent(ws)}/collections/${encodeURIComponent(id)}/export?format=${format}`,
    ),

  proxy: (payload: {
    execution_id: string;
    step_id: string;
    workflow_id: string;
    request: ResolvedRequest;
  }): Promise<ProxyResult> =>
    req<ProxyResult & { response: { status: number | null; body: unknown } }>(
      "/api/proxy",
      {
        method: "POST",
        body: JSON.stringify({
          execution_id: payload.execution_id,
          step_id: payload.step_id,
          workflow_id: payload.workflow_id,
          method: payload.request.method,
          url: payload.request.url,
          headers: payload.request.headers,
          body: payload.request.body ?? null,
        }),
      },
    ),
};
