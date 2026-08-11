import { useEffect, useState } from "react";

import { api, type WorkflowSummary } from "../../api/client";
import type { StepWorkflowBinding, ValueSource } from "../../types";
import { VariableBindingEditor } from "./VariableBindingEditor";

interface Props {
  binding: StepWorkflowBinding;
  workflows: WorkflowSummary[];
  selfId: string; // 자기 자신 연결 방지
  inputKeys: string[];
  envKeys: string[];
  prevStepIds: { id: string; label: string }[];
  onChange: (binding: StepWorkflowBinding) => void;
}

/**
 * 다른 업무(워크플로우) 연결 편집 — 대상 워크플로우를 고르고, 그 워크플로우의
 * 기본 입력값 key들을 부모 컨텍스트(기본입력값/환경변수/이전 output/고정값)로 매핑한다.
 */
export function WorkflowLinkEditor({
  binding,
  workflows,
  selfId,
  inputKeys,
  envKeys,
  prevStepIds,
  onChange,
}: Props) {
  const [targetInputKeys, setTargetInputKeys] = useState<string[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const targetId = binding.ref.id;
  const options = workflows.filter((w) => w.id !== selfId);

  // 대상 워크플로우의 기본 입력값 key 로드 (매핑 대상)
  useEffect(() => {
    if (!targetId) {
      setTargetInputKeys([]);
      return;
    }
    let alive = true;
    setLoadingKeys(true);
    setKeyError(null);
    api
      .getWorkflow(targetId, "edit")
      .then((wf) => {
        if (!alive) return;
        setTargetInputKeys(wf.baseInputs.map((i) => i.key).filter(Boolean));
      })
      .catch((e) => alive && setKeyError((e as Error).message))
      .finally(() => alive && setLoadingKeys(false));
    return () => {
      alive = false;
    };
  }, [targetId]);

  const setMapping = (variable: string, source: ValueSource) =>
    onChange({ ...binding, inputMappings: { ...binding.inputMappings, [variable]: source } });

  return (
    <div className="wf-link">
      <select
        value={targetId}
        onChange={(e) => onChange({ ref: { id: e.target.value }, inputMappings: {} })}
      >
        <option value="" disabled>
          연결할 업무 선택…
        </option>
        {options.map((w) => (
          <option key={w.id} value={w.id}>
            [{w.domain} / {w.task}] {w.name}
          </option>
        ))}
      </select>

      {targetId ? (
        <div className="binding-block">
          <h5>입력 매핑</h5>
          {loadingKeys ? <p className="muted">대상 입력값 불러오는 중…</p> : null}
          {keyError ? <div className="error-banner">{keyError}</div> : null}
          {!loadingKeys && !keyError ? (
            <VariableBindingEditor
              variables={targetInputKeys}
              bindings={binding.inputMappings}
              inputKeys={inputKeys}
              envKeys={envKeys}
              prevStepIds={prevStepIds}
              onChange={setMapping}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
