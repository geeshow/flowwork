import { useEffect, useMemo, useState } from "react";

import { api, VersionConflictError, type WorkflowSummary } from "../../api/client";
import { colorForDomain, isValidHex, PRESET_COLORS } from "../../domainPalette";
import { diffLines } from "../../engine/diff";
import type { CatalogEntry, EnvironmentValues, Workflow, WorkflowStep } from "../../types";
import { DiffTable } from "../edit/MergeView";
import { InputDefEditor } from "./InputDefEditor";
import { StepEditor } from "./StepEditor";

interface Props {
  mode: "new" | "edit";
  id?: string;
  initialDomain?: string; // 새 워크플로우 시 기본 도메인 (현재 보던 도메인 탭)
  initialTask?: string; // 새 워크플로우 시 기본 업무
  onSaved: (id: string) => void;
  onCancel: () => void;
}

// 도메인/업무는 파일 경로 세그먼트이므로 단어문자 + 한글 + 하이픈만 허용
const SAFE_SEGMENT = /^[\w가-힣-]+$/;

function emptyWorkflow(domain = "", task = ""): Workflow {
  return {
    id: crypto.randomUUID(),
    domain,
    task,
    name: "",
    description: "",
    baseInputs: [],
    steps: [],
  };
}

function newStep(): WorkflowStep {
  return {
    id: `step_${Math.random().toString(36).slice(2, 8)}`,
    order: 0,
    name: "", // API/업무를 선택하면 그 이름으로 자동 설정
    apiBinding: {
      catalogEntry: { department: "", collectionFile: "", itemPath: [], name: "" },
      variableBindings: {},
    },
  };
}

export function WorkflowEditor({ mode, id, initialDomain, initialTask, onSaved, onCancel }: Props) {
  const [wf, setWf] = useState<Workflow | null>(
    mode === "new" ? emptyWorkflow(initialDomain, initialTask) : null,
  );
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [env, setEnv] = useState<EnvironmentValues>({});
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [domainColors, setDomainColors] = useState<Record<string, string>>({});
  // 사용자가 직접 고른 색(도메인 색 오버라이드). 빈 문자열이면 도메인 기본색을 따른다.
  const [pickedColor, setPickedColor] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  // 동시 저장 충돌 — 다른 사용자가 조회 이후 같은 워크플로우를 저장/삭제한 경우.
  // server: 서버 최신본(null이면 삭제됨), mine: 내가 저장하려던 내용
  const [conflict, setConflict] = useState<{ server: Workflow | null; mine: Workflow } | null>(null);

  // 편집기는 항상 편집 worktree(source=edit) 기준으로 읽고 쓴다.
  // 저장 = worktree 파일 쓰기 (커밋 전 로컬 임시 저장) — git 커밋/머지는 편집 메뉴에서.
  useEffect(() => {
    let alive = true;
    Promise.all([api.searchCatalog("", "edit"), api.getEnvironments("edit"), api.listWorkflows("edit"), api.getDomainColors("edit")])
      .then(([cat, envs, wfs, colors]) => {
        if (!alive) return;
        setEntries(cat.results);
        setEnv(envs);
        setWorkflows(wfs);
        setDomainColors(colors);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (mode !== "edit" || !id) return;
    let alive = true;
    api
      .getWorkflow(id, "edit")
      .then((w) => alive && setWf(w))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [mode, id]);

  const envKeys = useMemo(() => new Set(Object.keys(env)), [env]);
  const inputKeys = useMemo(
    () => (wf ? wf.baseInputs.map((i) => i.key).filter(Boolean) : []),
    [wf],
  );

  const domainOptions = useMemo(
    () => [...new Set(workflows.map((w) => w.domain))].sort((a, b) => a.localeCompare(b, "ko")),
    [workflows],
  );
  const taskOptions = useMemo(
    () =>
      [...new Set(workflows.filter((w) => !wf || w.domain === wf.domain).map((w) => w.task))].sort(
        (a, b) => a.localeCompare(b, "ko"),
      ),
    [workflows, wf],
  );

  if (error && !wf) return <div className="error-banner">{error}</div>;
  if (!wf) return <p className="muted">불러오는 중…</p>;

  const identityReady = !!wf.domain.trim() && !!wf.task.trim() && !!wf.name.trim();

  // 이 워크플로우 도메인의 색상 (사용자가 고른 색 > 저장된 도메인 색 > 결정적 기본색)
  const domainColor = pickedColor || colorForDomain(wf.domain.normalize("NFC"), domainColors);

  const patch = (p: Partial<Workflow>) => setWf({ ...wf, ...p });

  const updateStep = (i: number, step: WorkflowStep) =>
    setWf({ ...wf, steps: wf.steps.map((s, idx) => (idx === i ? step : s)) });

  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= wf.steps.length) return;
    const next = [...wf.steps];
    [next[i], next[j]] = [next[j], next[i]];
    setWf({ ...wf, steps: next });
  };

  function validate(w: Workflow): string | null {
    if (!SAFE_SEGMENT.test(w.domain)) return "도메인은 영문/숫자/한글/-/_ 만 사용할 수 있습니다.";
    if (!SAFE_SEGMENT.test(w.task)) return "업무는 영문/숫자/한글/-/_ 만 사용할 수 있습니다.";
    if (!w.name.trim()) return "이름을 입력하세요.";
    // (도메인, 업무) 내 이름 중복 사전 검사 (서버도 409로 최종 검증)
    const dup = workflows.some(
      (x) => x.id !== w.id && x.domain === w.domain && x.task === w.task && x.name === w.name.trim(),
    );
    if (dup) return `'${w.domain}/${w.task}'에 이미 '${w.name}' 이름이 있습니다.`;
    for (const [idx, s] of w.steps.entries()) {
      if (s.workflowBinding) {
        if (!s.workflowBinding.ref.id) return `${idx + 1}번 스텝: 연결할 업무를 선택하세요.`;
      } else if (s.apiBinding) {
        if (!s.apiBinding.catalogEntry.name) return `${idx + 1}번 스텝: 처리 API를 선택하세요.`;
      } else {
        return `${idx + 1}번 스텝: 처리 방식(API 또는 업무 연결)을 설정하세요.`;
      }
    }
    return null;
  }

  async function handleSave(force = false) {
    const normalized: Workflow = {
      ...wf!,
      name: wf!.name.trim(),
      steps: wf!.steps.map((s, idx) => ({ ...s, order: idx + 1 })),
    };
    const problem = validate(normalized);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    setConflict(null);
    try {
      // 도메인 색상 먼저 저장 (선택/변경했든 아니든 도메인에 색을 확정해 둔다)
      const domain = normalized.domain.normalize("NFC");
      if (isValidHex(domainColor)) await api.setDomainColor(domain, domainColor);
      await api.saveWorkflow(normalized, { force });
      onSaved(normalized.id);
    } catch (e) {
      if (e instanceof VersionConflictError) {
        // 서버 최신본을 가져와 비교/해결 UI를 띄운다 (404면 삭제된 것)
        const server = await api.getWorkflow(normalized.id, "edit").catch(() => null);
        setConflict({ server, mine: normalized });
      } else {
        setError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }

  // 충돌 diff용 JSON (버전 메타는 비교에서 제외)
  const stripVersion = ({ version: _v, ...rest }: Workflow) => rest;

  return (
    <div className="editor">
      <div className="editor-head">
        <h2>{mode === "new" ? "새 워크플로우" : "워크플로우 편집"}</h2>
        <div className="editor-actions">
          <button className="link" onClick={onCancel}>
            취소
          </button>
          <button className="primary" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "저장 중…" : "저장"}
          </button>
        </div>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {conflict ? (
        <section className="panel save-conflict">
          <h3>⚠ 저장 충돌</h3>
          {conflict.server ? (
            <>
              <p className="muted">
                다른 사용자가 이 워크플로우를 먼저 저장했습니다. 서버 최신 내용(좌)과 내 수정(우)을
                비교한 뒤 해결하세요.
              </p>
              <DiffTable
                rows={diffLines(
                  JSON.stringify(stripVersion(conflict.server), null, 2),
                  JSON.stringify(stripVersion(conflict.mine), null, 2),
                )}
                leftLabel="서버 최신"
                rightLabel="내 수정"
              />
              <div className="save-conflict-actions">
                <button
                  className="link"
                  onClick={() => {
                    if (confirm("내 수정을 버리고 서버 최신 내용을 불러올까요?")) {
                      setWf(conflict.server);
                      setConflict(null);
                    }
                  }}
                >
                  서버 최신 내용 불러오기
                </button>
                <button
                  className="primary"
                  disabled={saving}
                  onClick={() => {
                    if (confirm("서버의 다른 사용자 수정을 덮어쓸까요?")) void handleSave(true);
                  }}
                >
                  내 수정으로 덮어쓰기 저장
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="muted">
                다른 사용자가 이 워크플로우를 삭제했습니다. 내 내용으로 다시 저장(복원)하거나 편집을
                취소하세요.
              </p>
              <div className="save-conflict-actions">
                <button className="primary" disabled={saving} onClick={() => void handleSave(true)}>
                  내 내용으로 다시 저장
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      <section className="panel">
        <h3>기본 정보</h3>
        <div className="meta-grid">
          <label className="field">
            <span className="field-label">도메인</span>
            <input
              list="domain-options"
              value={wf.domain}
              placeholder="예: 계좌 (선택 또는 입력)"
              onChange={(e) => {
                setPickedColor(""); // 도메인이 바뀌면 그 도메인의 색을 따르도록 오버라이드 해제
                patch({ domain: e.target.value });
              }}
            />
            <datalist id="domain-options">
              {domainOptions.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </label>
          <label className="field">
            <span className="field-label">업무</span>
            <input
              list="task-options"
              value={wf.task}
              placeholder="예: 계좌개설 (선택 또는 입력)"
              onChange={(e) => patch({ task: e.target.value })}
            />
            <datalist id="task-options">
              {taskOptions.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </label>
          <div className="field wide">
            <span className="field-label">
              도메인 색상 <span className="hint">(작업 테두리·불릿에 사용 · 도메인 단위로 저장)</span>
            </span>
            <div className="color-picker">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch ${domainColor.toLowerCase() === c.toLowerCase() ? "active" : ""}`}
                  style={{ background: c }}
                  title={c}
                  onClick={() => setPickedColor(c)}
                />
              ))}
              <label className="color-custom" title="직접 선택">
                <input
                  type="color"
                  value={isValidHex(domainColor) ? domainColor : "#4c8dff"}
                  onChange={(e) => setPickedColor(e.target.value)}
                />
                <span className="color-custom-face" style={{ background: domainColor }} />
              </label>
            </div>
          </div>
          <label className="field wide">
            <span className="field-label">이름 <span className="hint">(도메인·업무 내에서 유일)</span></span>
            <input value={wf.name} placeholder="정산 취소 처리" onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="field wide">
            <span className="field-label">설명</span>
            <input
              value={wf.description ?? ""}
              placeholder="고객 정산을 조회하고, 상태가 ACTIVE면 취소한다."
              onChange={(e) => patch({ description: e.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>환경 변수 <span className="hint">({Object.keys(env).length}개 · 읽기 전용)</span></h3>
          <button className="link" onClick={() => setEnvOpen((v) => !v)}>
            {envOpen ? "접기" : "보기"}
          </button>
        </div>
        {envOpen ? (
          Object.keys(env).length === 0 ? (
            <p className="muted">환경 변수가 없습니다.</p>
          ) : (
            <div className="env-list">
              {Object.entries(env).map(([k, v]) => (
                <div key={k} className="env-row">
                  <code className="env-key">{k}</code>
                  <code className="env-val">{v}</code>
                </div>
              ))}
            </div>
          )
        ) : null}
      </section>

      <section className="panel">
        <h3>기본 입력값 <span className="hint">(스텝보다 먼저 정의)</span></h3>
        <InputDefEditor
          inputs={wf.baseInputs}
          entries={entries}
          inputKeys={inputKeys}
          envKeys={[...envKeys]}
          onChange={(baseInputs) => patch({ baseInputs })}
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h3>스텝 ({wf.steps.length})</h3>
        </div>

        {!identityReady ? (
          <p className="muted">먼저 도메인·업무·이름을 입력하면 스텝을 추가할 수 있습니다.</p>
        ) : wf.steps.length === 0 ? (
          <p className="muted">스텝이 없습니다. 아래 "스텝 추가"로 API를 선택하고 입력을 매핑하세요.</p>
        ) : null}

        <div className="step-editor-list">
          {wf.steps.map((step, i) => (
            <StepEditor
              key={step.id}
              step={step}
              index={i}
              total={wf.steps.length}
              entries={entries}
              workflows={workflows}
              selfId={wf.id}
              envKeys={envKeys}
              inputKeys={inputKeys}
              prevSteps={wf.steps.slice(0, i).map((s, si) => ({ id: s.id, label: `${si + 1}. ${s.name || "스텝"}` }))}
              onChange={(s) => updateStep(i, s)}
              onRemove={() => setWf({ ...wf, steps: wf.steps.filter((_, idx) => idx !== i) })}
              onMove={(dir) => moveStep(i, dir)}
            />
          ))}
        </div>

        {identityReady ? (
          <button
            className="add-step-btn"
            onClick={() => setWf({ ...wf, steps: [...wf.steps, newStep()] })}
          >
            + 스텝 추가
          </button>
        ) : null}
      </section>
    </div>
  );
}
