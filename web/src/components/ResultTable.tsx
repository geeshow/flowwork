import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

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

interface ScrollState {
  overflow: boolean;
  fadeL: boolean;
  fadeR: boolean;
  thumbW: number; // %
  thumbL: number; // %
}
const same = (a: ScrollState, b: ScrollState) =>
  a.overflow === b.overflow &&
  a.fadeL === b.fadeL &&
  a.fadeR === b.fadeR &&
  Math.abs(a.thumbW - b.thumbW) < 0.5 &&
  Math.abs(a.thumbL - b.thumbL) < 0.5;

/**
 * 가로 스크롤 래퍼 — 오버레이(자동으로 사라지는) 스크롤바 대신, 항상 보이는
 * 커스텀 스크롤바(드래그 가능)를 하단에 렌더한다. 넘칠 때만 나타난다.
 */
function Scroller({ children }: { children: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [s, setS] = useState<ScrollState>({ overflow: false, fadeL: false, fadeR: false, thumbW: 100, thumbL: 0 });

  const update = () => {
    const el = wrapRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    const overflow = scrollWidth - clientWidth > 1;
    const next: ScrollState = {
      overflow,
      fadeL: scrollLeft > 2,
      fadeR: scrollLeft + clientWidth < scrollWidth - 2,
      thumbW: overflow ? Math.max(8, (clientWidth / scrollWidth) * 100) : 100,
      thumbL: overflow ? (scrollLeft / scrollWidth) * 100 : 0,
    };
    setS((prev) => (same(prev, next) ? prev : next));
  };

  // 스크롤/리사이즈 이벤트 구독
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 데이터/컬럼 변경 등 매 렌더 후에도 지표 재계산 (same() 가드로 무한루프 방지)
  useEffect(update);

  const onThumbDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const el = wrapRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const startX = e.clientX;
    const startScroll = el.scrollLeft;
    const ratio = el.scrollWidth / track.clientWidth; // 트랙 1px 이동당 실제 스크롤 px
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
    const onMove = (ev: MouseEvent) => {
      el.scrollLeft = startScroll + (ev.clientX - startX) * ratio;
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 트랙 빈 곳 클릭 시 해당 위치로 점프
  const onTrackDown = (e: ReactMouseEvent) => {
    if (e.target !== trackRef.current) return;
    const el = wrapRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    el.scrollLeft = frac * el.scrollWidth - el.clientWidth / 2;
  };

  return (
    <div className={`result-scroller ${s.fadeL ? "fade-l" : ""} ${s.fadeR ? "fade-r" : ""}`}>
      <div className="result-table-wrap" ref={wrapRef}>
        {children}
      </div>
      {s.overflow ? (
        <div className="hscroll" ref={trackRef} onMouseDown={onTrackDown}>
          <div
            className="hscroll-thumb"
            style={{ width: `${s.thumbW}%`, left: `${s.thumbL}%` }}
            onMouseDown={onThumbDown}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ResultTable({
  data,
  columns,
  labels,
}: {
  data: unknown;
  columns: string[];
  // 필드명 → 한글 설명(라벨). 라벨이 있으면 헤더에 라벨을, 없으면 필드명을 쓴다.
  labels?: Record<string, string>;
}) {
  const root = unwrap(data);
  const head = (c: string) => labels?.[c] ?? c;

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
                <th key={c} title={c}>
                  {head(c)}
                </th>
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
                <th title={c}>{head(c)}</th>
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
