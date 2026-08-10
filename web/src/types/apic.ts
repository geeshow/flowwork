// API 콜렉션 (Bruno 스타일) 도메인 타입 + 트리/변수 헬퍼.
// 서버는 콜렉션 문서를 통째로 저장/로드만 하고, 트리 편집은 프론트가 담당한다.

export interface ApicKV {
  name: string;
  value: string;
  enabled: boolean;
  description?: string; // 필드 한글 설명 (Bruno @description / Postman description 대응)
}

// 응답(output) 필드 — 이름만(문자열) 또는 한글 설명 포함({name, label})
export type ApicOutputField = string | { name: string; label?: string };

export function outputName(f: ApicOutputField): string {
  return typeof f === "string" ? f : f.name;
}

export function outputLabel(f: ApicOutputField): string | undefined {
  return typeof f === "string" ? undefined : f.label;
}

// params.kind: 쿼리스트링(query) 또는 경로 변수(path, URL의 :name 치환)
export interface ApicParam extends ApicKV {
  kind?: "query" | "path";
}

export type ApicBodyMode = "none" | "json" | "text";

export interface ApicRequest {
  method: string;
  url: string;
  headers: ApicKV[];
  params: ApicParam[];
  body: { mode: ApicBodyMode; json?: string; text?: string };
  output?: ApicOutputField[]; // 응답 필드 명세 (워크플로우 표시용)
}

export type ApicItem =
  | { type: "folder"; name: string; items: ApicItem[] }
  | { type: "http"; name: string; request: ApicRequest };

export interface ApicEnvironment {
  name: string;
  variables: ApicKV[];
}

export interface ApicCollection {
  id: string;
  name: string;
  items: ApicItem[];
  environments: ApicEnvironment[];
  activeEnvironment?: string | null;
  // GitHub 연결 정보 — import-github로 만든 콜렉션에 남고, 동기화(pull)에 쓰인다
  source?: { type: "github"; url: string };
}

export interface ApicWorkspace {
  name: string;
  collection_count: number;
}

export interface ApicCollectionSummary {
  id: string;
  name: string;
  request_count: number;
}

export function emptyRequest(): ApicRequest {
  return {
    method: "GET",
    url: "",
    headers: [],
    params: [],
    body: { mode: "none" },
  };
}

// ---------------------------------------------------------------------------
// 트리 헬퍼 — path는 items 배열 인덱스 경로. 전부 불변(immutable) 갱신.
// ---------------------------------------------------------------------------
export function getItem(items: ApicItem[], path: number[]): ApicItem | undefined {
  let cur: ApicItem | undefined;
  let list = items;
  for (const idx of path) {
    cur = list[idx];
    if (!cur) return undefined;
    list = cur.type === "folder" ? cur.items : [];
  }
  return cur;
}

export function updateItem(
  items: ApicItem[],
  path: number[],
  update: (item: ApicItem) => ApicItem,
): ApicItem[] {
  if (path.length === 0) return items;
  const [head, ...rest] = path;
  return items.map((item, i) => {
    if (i !== head) return item;
    if (rest.length === 0) return update(item);
    if (item.type !== "folder") return item;
    return { ...item, items: updateItem(item.items, rest, update) };
  });
}

export function removeItem(items: ApicItem[], path: number[]): ApicItem[] {
  if (path.length === 0) return items;
  const [head, ...rest] = path;
  if (rest.length === 0) return items.filter((_, i) => i !== head);
  return items.map((item, i) =>
    i === head && item.type === "folder"
      ? { ...item, items: removeItem(item.items, rest) }
      : item,
  );
}

/** folderPath가 빈 배열이면 루트에 추가한다. */
export function appendItem(items: ApicItem[], folderPath: number[], child: ApicItem): ApicItem[] {
  if (folderPath.length === 0) return [...items, child];
  return updateItem(items, folderPath, (item) =>
    item.type === "folder" ? { ...item, items: [...item.items, child] } : item,
  );
}

// ---------------------------------------------------------------------------
// 변수 치환 + 전송용 요청 조립
// ---------------------------------------------------------------------------
export function activeEnvVars(doc: ApicCollection): Record<string, string> {
  const env = doc.environments.find((e) => e.name === doc.activeEnvironment);
  const out: Record<string, string> = {};
  for (const v of env?.variables ?? []) {
    if (v.enabled && v.name) out[v.name] = v.value;
  }
  return out;
}

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
}

/** {{변수}} 치환 + path 파라미터(:name) 치환 + query 파라미터 부착 + 헤더/바디 조립. */
export function buildResolvedRequest(
  req: ApicRequest,
  vars: Record<string, string>,
): { method: string; url: string; headers: Record<string, string>; body?: unknown } {
  let url = interpolate(req.url.trim(), vars);

  for (const p of req.params) {
    if (p.kind === "path" && p.enabled && p.name) {
      url = url.replaceAll(`:${p.name}`, interpolate(p.value, vars));
    }
  }
  const query = req.params
    .filter((p) => (p.kind ?? "query") === "query" && p.enabled && p.name)
    .map(
      (p) =>
        `${encodeURIComponent(interpolate(p.name, vars))}=${encodeURIComponent(interpolate(p.value, vars))}`,
    );
  if (query.length > 0) url += (url.includes("?") ? "&" : "?") + query.join("&");

  const headers: Record<string, string> = {};
  for (const h of req.headers) {
    if (h.enabled && h.name) headers[interpolate(h.name, vars)] = interpolate(h.value, vars);
  }

  let body: unknown;
  if (req.body.mode === "json") {
    const raw = interpolate(req.body.json ?? "", vars);
    if (raw.trim()) body = JSON.parse(raw); // 호출부에서 SyntaxError 처리
  } else if (req.body.mode === "text") {
    body = interpolate(req.body.text ?? "", vars);
  }
  return { method: req.method, url, headers, body };
}
