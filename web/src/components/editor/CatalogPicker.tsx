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
  // 콜렉션 필터 — 여러 GitHub 레포/workspace에서 동기화된 콜렉션 중 하나를 골라 좁힌다
  const [colFilter, setColFilter] = useState("");

  const selected = entries.find((e) => e.id === selectedId) ?? null;

  // (workspace, 콜렉션) 필터 옵션 — 엔트리에서 유일한 콜렉션 목록 도출
  const collections = useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    for (const e of entries) {
      if (!seen.has(e.collectionFile)) {
        seen.set(e.collectionFile, {
          id: e.collectionFile,
          label: `${e.department} / ${e.collectionName || e.collectionFile}`,
        });
      }
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, "ko"));
  }, [entries]);

  const results = useMemo(() => {
    // 한글 입력 정규화(NFC) — 조합/분해 표현이 섞여도 검색이 되도록
    const norm = (s: string) => s.normalize("NFC").toLowerCase();
    const needle = norm(q.trim());
    const scoped = colFilter ? entries.filter((e) => e.collectionFile === colFilter) : entries;
    const list = needle
      ? scoped.filter(
          (e) =>
            norm(e.name).includes(needle) ||
            norm(e.url).includes(needle) ||
            e.itemPath.some((p) => norm(p).includes(needle)) ||
            norm(e.department).includes(needle),
        )
      : scoped;
    return list.slice(0, 30);
  }, [entries, q, colFilter]);

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
          + API 콜렉션에서 API 선택
        </button>
      )}

      {open || !selected ? (
        <div className="catalog-search">
          <div className="catalog-filter-row">
            <select
              value={colFilter}
              onChange={(e) => setColFilter(e.target.value)}
              title="콜렉션으로 좁히기 (workspace / 콜렉션)"
            >
              <option value="">전체 콜렉션</option>
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="API 검색 (이름 / URL / workspace / 폴더)"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
          </div>
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
