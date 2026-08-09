import type {
  CatalogEntry,
  EnvironmentValues,
  ResolvedRequest,
  Workflow,
} from "../types";
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
  group: string;
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

  getWorkflow: (group: string, id: string) =>
    req<Workflow>(`/api/workflows/${group}/${id}`),

  saveWorkflow: (wf: Workflow) =>
    req<{ status: string }>(`/api/workflows/${wf.group}/${wf.id}`, {
      method: "PUT",
      body: JSON.stringify(wf),
    }),

  searchCatalog: (q = "") =>
    req<{ results: CatalogEntry[]; catalog_version: string | null }>(
      `/api/catalog/search?q=${encodeURIComponent(q)}`,
    ),

  getEnvironments: () =>
    req<{ values: EnvironmentValues }>("/api/catalog/environments").then((r) => r.values),

  listExecutions: () =>
    req<{ executions: ExecutionSummary[] }>("/api/executions").then((r) => r.executions),

  getExecution: (id: string) =>
    req<{ execution_id: string; steps: unknown[] }>(`/api/executions/${id}`),

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
