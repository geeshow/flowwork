import { describe, expect, it, vi } from "vitest";

import { ComboCache, extractOne, extractRows } from "./comboCache";

describe("ComboCache", () => {
  it("완료 결과를 캐시해 loader를 한 번만 호출", async () => {
    const cache = new ComboCache();
    const loader = vi.fn(async () => [{ label: "A", value: "1" }]);
    await cache.get("k", loader);
    await cache.get("k", loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("in-flight promise를 공유해 동시 호출 시 중복 요청 안 함", async () => {
    const cache = new ComboCache();
    let resolve!: (v: { label: string; value: string }[]) => void;
    const loader = vi.fn(() => new Promise<{ label: string; value: string }[]>((r) => (resolve = r)));

    const p1 = cache.get("k", loader);
    const p2 = cache.get("k", loader); // 아직 미완료 → 같은 promise
    expect(loader).toHaveBeenCalledTimes(1);

    resolve([{ label: "A", value: "1" }]);
    expect(await p1).toEqual(await p2);
  });

  it("TTL 경과 후에는 다시 loader 호출", async () => {
    let t = 1000;
    const cache = new ComboCache(100, () => t);
    const loader = vi.fn(async () => [{ label: "A", value: "1" }]);
    await cache.get("k", loader);
    t += 200; // TTL(100) 초과
    await cache.get("k", loader);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("extractRows / extractOne", () => {
  it("배열 body와 {data:[...]} body 모두 행으로 추출", () => {
    expect(extractRows([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(extractRows({ data: [{ id: 2 }] })).toEqual([{ id: 2 }]);
    expect(extractRows({ other: 1 })).toEqual([]);
  });

  it("단일 객체 추출: {data:{...}} / {data:[...]} / 배열", () => {
    expect(extractOne({ data: { name: "kim" } })).toEqual({ name: "kim" });
    expect(extractOne({ data: [{ name: "lee" }] })).toEqual({ name: "lee" });
    expect(extractOne([{ name: "park" }])).toEqual({ name: "park" });
  });
});
