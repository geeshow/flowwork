import { useEffect, useMemo, useState } from "react";

import { api, type ConflictFile } from "../../api/client";
import { diffLines, type DiffRow } from "../../engine/diff";
import type { Workflow, WorkflowStep } from "../../types";

/**
 * develop 머지 충돌 해결 화면.
 *
 * 파일마다 develop(ours) ↔ feature(theirs)를
 *   1) 워크플로우 시각 비교(스텝 단위 좌우 비교)
 *   2) JSON 라인 diff(좌우 비교)
 * 로 보여주고, 해결안(JSON)을 직접 편집해 확정한다.
 * 모든 파일이 해결되면 머지 커밋을 완료한다.
 */
export function MergeView({ onDone }: { onDone: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [inMerge, setInMerge] = useState(false);
  const [sourceBranch, setSourceBranch] = useState<string | null>(null);
  const [files, setFiles] = useState<ConflictFile[]>([]);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .editConflicts()
      .then((r) => {
        if (!alive) return;
        setInMerge(r.in_merge);
        setSourceBranch(r.source_branch);
        setFiles(r.files);
        setLoaded(true);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  if (error && !loaded) return <div className="error-banner">{error}</div>;
  if (!loaded) return <p className="muted">충돌 정보를 불러오는 중…</p>;
  if (!inMerge)
    return (
      <div className="detail-empty">
        <p className="muted">진행 중인 머지가 없습니다.</p>
        <button className="link" onClick={onDone}>
          ← 편집으로 돌아가기
        </button>
      </div>
    );

  const allResolved = files.every((f) => resolved.has(f.path));

  async function finishMerge() {
    setBusy(true);
    setError(null);
    try {
      await api.editMergeContinue();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function abortMerge() {
    if (!confirm("머지를 중단할까요? 지금까지의 충돌 해결 내용은 사라집니다.")) return;
    setBusy(true);
    setError(null);
    try {
      await api.editMergeAbort();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="merge-view">
      <div className="merge-head">
        <h2>머지 충돌 해결</h2>
        <span className="muted">
          {sourceBranch ?? "feature"} → develop · 충돌 {files.length}건 중 {resolved.size}건 해결
        </span>
        <div className="merge-head-actions">
          <button className="primary" disabled={busy || !allResolved} onClick={finishMerge}>
            머지 완료 (커밋)
          </button>
          <button className="link danger" disabled={busy} onClick={abortMerge}>
            머지 중단
          </button>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {files.map((f) => (
        <ConflictCard
          key={f.path}
          file={f}
          resolved={resolved.has(f.path)}
          onResolved={() => setResolved((s) => new Set(s).add(f.path))}
          onUnresolve={() =>
            setResolved((s) => {
              const next = new Set(s);
              next.delete(f.path);
              return next;
            })
          }
        />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
function parseWorkflow(raw: string | null): Workflow | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && Array.isArray(data.steps) ? (data as Workflow) : null;
  } catch {
    return null;
  }
}

function ConflictCard({
  file,
  resolved,
  onResolved,
  onUnresolve,
}: {
  file: ConflictFile;
  resolved: boolean;
  onResolved: () => void;
  onUnresolve: () => void;
}) {
  const ours = file.ours ?? "";
  const theirs = file.theirs ?? "";
  const [content, setContent] = useState(theirs || ours); // 기본은 feature(내 수정) 쪽
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"visual" | "json">("visual");

  const isJson = file.path.endsWith(".json");
  const jsonProblem = useMemo(() => {
    if (!isJson) return null;
    try {
      JSON.parse(content);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }, [content, isJson]);

  const oursWf = useMemo(() => parseWorkflow(file.ours), [file.ours]);
  const theirsWf = useMemo(() => parseWorkflow(file.theirs), [file.theirs]);
  const rows = useMemo(() => diffLines(ours, theirs), [ours, theirs]);

  async function resolve() {
    setSaving(true);
    setError(null);
    try {
      // JSON 파일이면 정규화(들여쓰기 2)해서 저장
      const body = isJson ? JSON.stringify(JSON.parse(content), null, 2) : content;
      await api.editResolveConflict(file.path, body);
      onResolved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`panel conflict-card ${resolved ? "resolved" : ""}`}>
      <div className="conflict-card-head">
        <div>
          {file.kind === "workflow" ? (
            <h3>
              {file.name} <span className="muted">— {file.domain} / {file.task}</span>
            </h3>
          ) : (
            <h3>
              <code>{file.path}</code>
            </h3>
          )}
          <span className="muted small-text">{file.path}</span>
        </div>
        {resolved ? (
          <span className="conflict-resolved-mark">
            ✓ 해결됨{" "}
            <button className="link" onClick={onUnresolve}>
              다시 편집
            </button>
          </span>
        ) : null}
      </div>

      <div className="conflict-tabs">
        <button className={tab === "visual" ? "active" : ""} onClick={() => setTab("visual")}>
          워크플로우 비교
        </button>
        <button className={tab === "json" ? "active" : ""} onClick={() => setTab("json")}>
          JSON diff
        </button>
      </div>

      {tab === "visual" ? (
        oursWf || theirsWf ? (
          <WorkflowSideBySide ours={oursWf} theirs={theirsWf} />
        ) : (
          <p className="muted">워크플로우 형식이 아니어서 시각 비교를 표시할 수 없습니다. JSON diff를 확인하세요.</p>
        )
      ) : (
        <DiffTable rows={rows} />
      )}

      {!resolved ? (
        <div className="conflict-resolver">
          <div className="conflict-resolver-head">
            <h4>해결안 (직접 편집 가능)</h4>
            <div className="conflict-pick">
              <button className="link" onClick={() => setContent(ours)}>
                ← develop 버전 가져오기
              </button>
              <button className="link" onClick={() => setContent(theirs)}>
                feature 버전 가져오기 →
              </button>
              {file.merged ? (
                <button className="link" onClick={() => setContent(file.merged!)} title="충돌 마커 포함 원본">
                  충돌 마커 원본
                </button>
              ) : null}
            </div>
          </div>
          <textarea
            className="conflict-editor"
            value={content}
            spellCheck={false}
            onChange={(e) => setContent(e.target.value)}
          />
          {jsonProblem ? <div className="error-banner">JSON 형식 오류: {jsonProblem}</div> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          <div className="conflict-resolver-actions">
            <button className="primary" disabled={saving || !!jsonProblem} onClick={resolve}>
              {saving ? "저장 중…" : "이 내용으로 해결"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 워크플로우 좌우 시각 비교 — 스텝 id 기준 추가/삭제/변경 하이라이트
// ---------------------------------------------------------------------------
function stepKind(s: WorkflowStep): string {
  if (s.workflowBinding) return "업무 연결";
  if (s.apiBinding) return "API";
  return "미설정";
}

function WorkflowSideBySide({ ours, theirs }: { ours: Workflow | null; theirs: Workflow | null }) {
  const oursSteps = ours ? [...ours.steps].sort((a, b) => a.order - b.order) : [];
  const theirsSteps = theirs ? [...theirs.steps].sort((a, b) => a.order - b.order) : [];
  const oursById = new Map(oursSteps.map((s) => [s.id, s]));
  const theirsById = new Map(theirsSteps.map((s) => [s.id, s]));

  const mark = (s: WorkflowStep, other: Map<string, WorkflowStep>) => {
    const counterpart = other.get(s.id);
    if (!counterpart) return "only"; // 이쪽에만 있음
    return JSON.stringify(counterpart) !== JSON.stringify(s) ? "changed" : "same";
  };

  const metaDiff = (key: keyof Workflow) =>
    ours && theirs && JSON.stringify(ours[key]) !== JSON.stringify(theirs[key]) ? "changed" : "same";

  const renderCol = (
    wf: Workflow | null,
    steps: WorkflowStep[],
    other: Map<string, WorkflowStep>,
    label: string,
    side: "ours" | "theirs",
  ) => (
    <div className={`wf-compare-col ${side}`}>
      <div className="wf-compare-col-head">{label}</div>
      {!wf ? (
        <p className="muted">(이 쪽에서는 삭제됨)</p>
      ) : (
        <>
          <div className={`wf-compare-meta ${metaDiff("name")}`}>
            <span className="muted">이름</span> {wf.name}
          </div>
          <div className={`wf-compare-meta ${metaDiff("domain") === "changed" || metaDiff("task") === "changed" ? "changed" : "same"}`}>
            <span className="muted">위치</span> {wf.domain} / {wf.task}
          </div>
          {wf.description ? (
            <div className={`wf-compare-meta ${metaDiff("description")}`}>
              <span className="muted">설명</span> {wf.description}
            </div>
          ) : null}
          <div className={`wf-compare-meta ${metaDiff("baseInputs")}`}>
            <span className="muted">기본 입력값</span> {wf.baseInputs.length}개
          </div>
          <div className="wf-compare-steps">
            {steps.map((s) => {
              const m = mark(s, other);
              return (
                <div key={s.id} className={`wf-compare-step ${m}`}>
                  <span className="step-order">{s.order}</span>
                  <span className="step-name">{s.name || "(이름 없음)"}</span>
                  <span className="step-kind">{stepKind(s)}</span>
                  {m === "only" ? <span className="step-mark">이쪽에만</span> : null}
                  {m === "changed" ? <span className="step-mark">변경됨</span> : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="wf-compare">
      {renderCol(ours, oursSteps, theirsById, "develop (기존)", "ours")}
      {renderCol(theirs, theirsSteps, oursById, "feature (내 수정)", "theirs")}
    </div>
  );
}

// ---------------------------------------------------------------------------
// JSON 라인 diff (좌: develop / 우: feature)
// ---------------------------------------------------------------------------
function DiffTable({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="diff-table-wrap">
      <div className="diff-table">
        <div className="diff-col-head">develop</div>
        <div className="diff-col-head">feature</div>
        {rows.map((r, i) => (
          <div key={i} className="diff-row" data-type={r.type}>
            <div className={`diff-cell left ${r.left ? r.type : "empty"}`}>
              {r.left ? (
                <>
                  <span className="diff-no">{r.left.no}</span>
                  <code>{r.left.text}</code>
                </>
              ) : null}
            </div>
            <div className={`diff-cell right ${r.right ? r.type : "empty"}`}>
              {r.right ? (
                <>
                  <span className="diff-no">{r.right.no}</span>
                  <code>{r.right.text}</code>
                </>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
