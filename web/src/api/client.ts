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

export interface ExecutionSummary {
  execution_id: string;
  step_count: number;
  overall_status: "SUCCESS" | "FAILED";
  started_at?: number;
  workflow_id?: string;
}

export const api = {
  listWorkflows: () =>
    req<{ workflows: WorkflowSummary[] }>("/api/workflows").then((r) => r.workflows),

  getWorkflow: (id: string) => req<Workflow>(`/api/workflows/${id}`),

  saveWorkflow: (wf: Workflow) =>
    req<{ status: string }>(`/api/workflows/${wf.id}`, {
      method: "PUT",
      body: JSON.stringify(wf),
    }),

  deleteWorkflow: (id: string) =>
    req<{ status: string }>(`/api/workflows/${id}`, { method: "DELETE" }),

  searchCatalog: (q = "") =>
    req<{ results: CatalogEntry[]; catalog_version: string | null }>(
      `/api/catalog/search?q=${encodeURIComponent(q)}`,
    ),

  getEnvironments: () =>
    req<{ values: EnvironmentValues }>("/api/catalog/environments").then((r) => r.values),

  // 도메인 → 팔레트 색상 id 매핑
  getDomainColors: () =>
    req<{ colors: Record<string, string> }>("/api/domains").then((r) => r.colors),

  setDomainColor: (domain: string, color: string) =>
    req<{ status: string }>(`/api/domains/${encodeURIComponent(domain)}`, {
      method: "PUT",
      body: JSON.stringify({ color }),
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
