import type { Primitive, ValueSource } from "../../types";

interface Props {
  variables: string[]; // 카탈로그 항목의 {{변수}} 목록 (env 변수 제외됨)
  bindings: Record<string, ValueSource>;
  inputKeys: string[]; // 이 워크플로우의 입력값 key 목록
  prevStepIds: { id: string; label: string }[]; // 이전 스텝(PREV_RESPONSE 대상)
  onChange: (variable: string, source: ValueSource) => void;
}

type SourceKind = ValueSource["kind"];

const DEFAULT_BY_KIND: Record<SourceKind, ValueSource> = {
  USER_INPUT: { kind: "USER_INPUT", inputKey: "" },
  FIXED: { kind: "FIXED", value: "" },
  PREV_RESPONSE: { kind: "PREV_RESPONSE", stepId: "", jsonPath: "$." },
};

/**
 * 변수 바인딩 — API의 {{변수}}마다 값 소스(직접입력 값 / 사용자 입력 / 이전 응답 참조)를
 * 하나씩 고른다. 별도 매핑 스키마 없이 ValueSource union을 그대로 편집한다.
 */
export function VariableBindingEditor({
  variables,
  bindings,
  inputKeys,
  prevStepIds,
  onChange,
}: Props) {
  if (variables.length === 0) {
    return <p className="muted">바인딩할 변수가 없습니다 (환경변수만 사용).</p>;
  }

  return (
    <div className="binding-list">
      {variables.map((v) => {
        const src = bindings[v];
        return (
          <div key={v} className="binding-row">
            <code className="binding-var">{`{{${v}}}`}</code>
            <select
              value={src?.kind ?? ""}
              onChange={(e) => onChange(v, DEFAULT_BY_KIND[e.target.value as SourceKind])}
            >
              <option value="" disabled>
                소스 선택…
              </option>
              <option value="USER_INPUT">사용자 입력</option>
              <option value="FIXED">고정값</option>
              <option value="PREV_RESPONSE">이전 응답 참조</option>
            </select>

            {src?.kind === "USER_INPUT" ? (
              <select
                value={src.inputKey}
                onChange={(e) => onChange(v, { kind: "USER_INPUT", inputKey: e.target.value })}
              >
                <option value="" disabled>
                  입력값 선택…
                </option>
                {inputKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            ) : null}

            {src?.kind === "FIXED" ? (
              <input
                type="text"
                placeholder="고정값"
                value={src.value == null ? "" : String(src.value)}
                onChange={(e) =>
                  onChange(v, { kind: "FIXED", value: e.target.value as Primitive })
                }
              />
            ) : null}

            {src?.kind === "PREV_RESPONSE" ? (
              <>
                <select
                  value={src.stepId}
                  onChange={(e) =>
                    onChange(v, { kind: "PREV_RESPONSE", stepId: e.target.value, jsonPath: src.jsonPath })
                  }
                >
                  <option value="" disabled>
                    스텝 선택…
                  </option>
                  {prevStepIds.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="$.data.settlementId"
                  value={src.jsonPath}
                  onChange={(e) =>
                    onChange(v, { kind: "PREV_RESPONSE", stepId: src.stepId, jsonPath: e.target.value })
                  }
                />
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
