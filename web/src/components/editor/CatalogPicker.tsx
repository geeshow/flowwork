import { useMemo, useState } from "react";

import type { CatalogEntry } from "../../types";

interface Props {
  entries: CatalogEntry[];
  selectedId: string | null;
  onSelect: (entry: CatalogEntry) => void;
}

/**
 * 카탈로그 검색 후 등록 — 검색어로 필터링하고, 부서/폴더 breadcrumb과 함께
 * 개별 API를 고른다. (아키텍처 4.3: 부서→업무 폴더→API 드릴다운의 경량 버전)
 */
export function CatalogPicker({ entries, selectedId, onSelect }: Props) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);

  const selected = entries.find((e) => e.id === selectedId) ?? null;

  const results = useMemo(() => {
    // 한글 입력 정규화(NFC) — 조합/분해 표현이 섞여도 검색이 되도록
    const norm = (s: string) => s.normalize("NFC").toLowerCase();
    const needle = norm(q.trim());
    const list = needle
      ? entries.filter(
          (e) =>
            norm(e.name).includes(needle) ||
            norm(e.url).includes(needle) ||
            e.itemPath.some((p) => norm(p).includes(needle)) ||
            norm(e.department).includes(needle),
        )
      : entries;
    return list.slice(0, 30);
  }, [entries, q]);

  return (
    <div className="catalog-picker">
      {selected ? (
        <div className="catalog-selected">
          <div>
            <span className={`method ${selected.method.toLowerCase()}`}>{selected.method}</span>
            <strong>{selected.name}</strong>
            <span className="breadcrumb">
              {[selected.department, ...selected.itemPath].join(" / ")}
            </span>
          </div>
          <button className="link" onClick={() => setOpen((v) => !v)}>
            {open ? "닫기" : "변경"}
          </button>
        </div>
      ) : (
        <button className="link" onClick={() => setOpen(true)}>
          + 카탈로그에서 API 선택
        </button>
      )}

      {open || !selected ? (
        <div className="catalog-search">
          <input
            type="text"
            placeholder="API 검색 (이름 / URL / 부서 / 폴더)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <ul className="catalog-results">
            {results.length === 0 ? <li className="muted">결과 없음</li> : null}
            {results.map((e) => (
              <li key={e.id}>
                <button
                  className={`catalog-result ${e.id === selectedId ? "active" : ""}`}
                  onClick={() => {
                    onSelect(e);
                    setOpen(false);
                  }}
                >
                  <span className={`method ${e.method.toLowerCase()}`}>{e.method}</span>
                  <span className="catalog-name">{e.name}</span>
                  <span className="breadcrumb">
                    {[e.department, ...e.itemPath].join(" / ")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
