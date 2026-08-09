import { useEffect, useRef, useState } from "react";

// 스텝 응답을 표로 렌더링한다.
//  - data에서 { data: ... }를 자동 언랩
//  - 언랩 결과가 배열이면: 각 원소가 행, columns가 열 (columns 비면 전체 키 자동)
//  - 객체면: 필드/값 2열 표 (columns 비면 전체 키 자동)
//  - 셀 값이 객체/배열(다차원)이면 압축 JSON으로 표시
//  - columns 항목은 점 표기(owner.name)로 중첩 값 접근

function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "data" in (body as object)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (o == null || typeof o !== "object") return undefined;
    return (o as Record<string, unknown>)[k];
  }, obj);
}

function cell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function keysOf(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  for (const r of rows) {
    if (r && typeof r === "object") {
      for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
    }
  }
  return seen;
}

/**
 * 가로 스크롤 래퍼 — 오버레이 스크롤바 환경에서도 좌우 스크롤 가능 여부가 보이도록
 * 넘치는 쪽에 페이드 그림자를 표시한다.
 */
function Scroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setFade({
        left: el.scrollLeft > 2,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div className={`result-scroller ${fade.left ? "fade-l" : ""} ${fade.right ? "fade-r" : ""}`}>
      <div className="result-table-wrap" ref={ref}>
        {children}
      </div>
      {fade.right ? <span className="scroll-hint">더보기 ›</span> : null}
    </div>
  );
}

export function ResultTable({ data, columns }: { data: unknown; columns: string[] }) {
  const root = unwrap(data);

  if (Array.isArray(root)) {
    const rows = root as Record<string, unknown>[];
    const cols = columns.length ? columns : keysOf(rows);
    if (rows.length === 0) return <p className="muted result-empty">결과 없음 (빈 배열)</p>;
    return (
      <Scroller>
        <table className="result-table">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c}>{cell(getPath(row, c))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>
    );
  }

  if (root && typeof root === "object") {
    const obj = root as Record<string, unknown>;
    const cols = columns.length ? columns : Object.keys(obj);
    return (
      <Scroller>
        <table className="result-table kv">
          <tbody>
            {cols.map((c) => (
              <tr key={c}>
                <th>{c}</th>
                <td>{cell(getPath(obj, c))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Scroller>
    );
  }

  return <p className="result-empty">{cell(root)}</p>;
}
