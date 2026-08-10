import type { ApicKV, ApicParam } from "../../types/apic";

/**
 * 이름/값/사용 체크박스 행 편집기 — 헤더·쿼리 파라미터·환경변수 공용.
 * withKind가 켜지면 파라미터 종류(쿼리/경로) 선택 셀이 추가된다.
 */
export function KVEditor({
  rows,
  onChange,
  withKind = false,
  namePlaceholder = "이름",
  valuePlaceholder = "값",
}: {
  rows: ApicParam[];
  onChange: (rows: ApicParam[]) => void;
  withKind?: boolean;
  namePlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const patch = (i: number, p: Partial<ApicParam>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="kv-editor">
      {rows.map((row, i) => (
        <div key={i} className="kv-row">
          <input
            type="checkbox"
            checked={row.enabled}
            onChange={(e) => patch(i, { enabled: e.target.checked })}
            title="사용"
          />
          <input
            className="kv-name"
            value={row.name}
            placeholder={namePlaceholder}
            onChange={(e) => patch(i, { name: e.target.value })}
          />
          <input
            className="kv-value"
            value={row.value}
            placeholder={valuePlaceholder}
            onChange={(e) => patch(i, { value: e.target.value })}
          />
          <input
            className="kv-desc"
            value={row.description ?? ""}
            placeholder="설명"
            title="필드 한글 설명 (내보내기 시 Bruno @description / Postman description으로 보존)"
            onChange={(e) => patch(i, { description: e.target.value || undefined })}
          />
          {withKind ? (
            <select
              value={row.kind ?? "query"}
              onChange={(e) => patch(i, { kind: e.target.value as ApicParam["kind"] })}
            >
              <option value="query">쿼리</option>
              <option value="path">경로(:이름)</option>
            </select>
          ) : null}
          <button
            className="icon-btn danger"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            title="삭제"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="link small"
        onClick={() => onChange([...rows, { name: "", value: "", enabled: true } as ApicKV])}
      >
        + 추가
      </button>
    </div>
  );
}
