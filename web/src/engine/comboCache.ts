// API_COMBO 옵션 캐시 — 완료 결과 캐시 + in-flight promise 공유로 중복 호출 방지.
// React와 무관한 순수 로직이라 단독 테스트 가능. 훅/Provider는 이 클래스를 감싼다.

export interface ComboOption {
  label: string;
  value: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class ComboCache {
  private readonly ttl: number;
  private readonly done = new Map<string, { data: ComboOption[]; fetchedAt: number }>();
  private readonly inFlight = new Map<string, Promise<ComboOption[]>>();
  private readonly now: () => number;

  constructor(ttlMs: number = DEFAULT_TTL_MS, now: () => number = Date.now) {
    this.ttl = ttlMs;
    this.now = now;
  }

  async get(key: string, loader: () => Promise<ComboOption[]>): Promise<ComboOption[]> {
    const cached = this.done.get(key);
    if (cached && this.now() - cached.fetchedAt < this.ttl) return cached.data;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = loader()
      .then((data) => {
        this.done.set(key, { data, fetchedAt: this.now() });
        return data;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    return promise;
  }
}

/** 응답 body에서 행 배열을 뽑아낸다 (배열 자체 / {data:[...]} 모두 허용). */
export function extractRows(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) return data as Record<string, unknown>[];
  }
  return [];
}

/** 응답 body에서 단일 객체(의존 조회 결과)를 뽑아낸다. */
export function extractOne(body: unknown): Record<string, unknown> | null {
  if (Array.isArray(body)) return (body[0] as Record<string, unknown>) ?? null;
  if (body && typeof body === "object") {
    const data = (body as { data?: unknown }).data;
    if (Array.isArray(data)) return (data[0] as Record<string, unknown>) ?? null;
    if (data && typeof data === "object") return data as Record<string, unknown>;
    return body as Record<string, unknown>;
  }
  return null;
}
