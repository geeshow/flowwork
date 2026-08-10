import { useState, type ReactNode } from "react";

import type { StepExecutionState, StepResultView, StepStatus, WorkflowStep } from "../types";
import { ResultTable } from "./ResultTable";

/**
 * 스텝 종류 배지/분류 계산.
 *  - API 스텝: "API" + "부서 > 폴더" (카탈로그 분류)
 *  - 연결업무 스텝: "연결업무" + "도메인 > 업무 > 업무명" (연결된 워크플로우)
 */
export function stepTypeMeta(
  step: Pick<WorkflowStep, "apiBinding" | "workflowBinding">,
  resolveWorkflow?: (id: string) => { domain: string; task: string; name: string } | undefined,
): { typeLabel: "API" | "연결업무"; category: string } {
  if (step.workflowBinding) {
    const w = resolveWorkflow?.(step.workflowBinding.ref.id);
    return { typeLabel: "연결업무", category: w ? `${w.domain} > ${w.task} > ${w.name}` : "" };
  }
  const ce = step.apiBinding?.catalogEntry;
  return { typeLabel: "API", category: ce ? [ce.department, ...ce.itemPath].join(" > ") : "" };
}

const STATUS_META: Record<StepStatus, { icon: string; label: string; cls: string }> = {
  PENDING: { icon: "○", label: "대기", cls: "pending" },
  RUNNING: { icon: "◍", label: "실행 중", cls: "running" },
  SUCCESS: { icon: "✓", label: "성공", cls: "success" },
  FAILED: { icon: "✕", label: "실패", cls: "failed" },
  SKIPPED: { icon: "⤼", label: "건너뜀", cls: "skipped" },
};

interface Props {
  step: Pick<WorkflowStep, "id" | "order" | "name">;
  state: StepExecutionState | undefined;
  // 응답 표시 방식 (표/원본 + 컬럼). 없으면 원본 JSON.
  resultView?: StepResultView;
  // 스텝 종류 배지: "API" 또는 "연결업무"
  typeLabel?: "API" | "연결업무";
  // 분류 경로: API는 "부서 > 폴더", 연결업무는 "도메인 > 업무 > 업무명"
  category?: string;
  // 결과 표 헤더용 필드 설명(라벨) 맵 — 설명이 있으면 설명, 없으면 필드명 표시
  outputLabels?: Record<string, string>;
  // 카드 하단 슬롯 — 중간 입력 폼 등. 있으면 카드를 펼친 채로 렌더한다.
  footer?: ReactNode;
}

/**
 * 스텝 카드 — 실행 상태를 색/아이콘으로 표시하고, 클릭 시 request/response 전체를
 * JSON 뷰어로 펼친다. 실행 화면과 히스토리 상세가 동일 컴포넌트를 재사용한다.
 */
export function StepCard({ step, state, resultView, typeLabel, category, outputLabels, footer }: Props) {
  const [open, setOpen] = useState(false);
  // 표 모드로 설정돼 있으면 표를 기본으로, 필요 시 원본 JSON으로 토글
  const [rawResp, setRawResp] = useState(false);
  const status = state?.status ?? "PENDING";
  const meta = STATUS_META[status];
  const hasDetail = state?.request || state?.response || state?.error;
  const asTable = resultView?.mode === "TABLE";
  // 중간 입력이 뜬 동안에는 결과를 보고 선택해야 하므로 상세(응답)를 강제로 펼친다.
  const showDetail = hasDetail && (open || !!footer);

  return (
    <div className={`step-card ${meta.cls}`}>
      <button
        className="step-head"
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={showDetail}
      >
        <span className="step-order">{step.order}</span>
        <span className="step-name">
          <span className="step-name-text">
            <span className="step-name-row">
              {typeLabel ? (
                <span className={`step-type-badge ${typeLabel === "API" ? "api" : "wf"}`}>{typeLabel}</span>
              ) : null}
              <span>{step.name || `스텝 ${step.order}`}</span>
            </span>
            {category ? <span className="step-category">{category}</span> : null}
          </span>
        </span>
        <span className={`step-status ${meta.cls}`}>
          <span className="step-icon">{meta.icon}</span> {meta.label}
        </span>
        {hasDetail ? <span className="chevron">{showDetail ? "▾" : "▸"}</span> : null}
      </button>

      {showDetail ? (
        <div className="step-detail">
          {state?.error ? <JsonBlock title="에러" data={state.error} /> : null}
          {state?.request ? <JsonBlock title="요청" data={state.request} /> : null}
          {state?.response !== undefined ? (
            asTable && !rawResp ? (
              <div className="json-block">
                <div className="json-title">
                  <span>응답</span>
                  <button className="link small" onClick={() => setRawResp(true)}>
                    { } 원본
                  </button>
                </div>
                <ResultTable data={state.response} columns={resultView!.columns} labels={outputLabels} />
              </div>
            ) : asTable && rawResp ? (
              <div className="json-block">
                <div className="json-title">
                  <span>응답</span>
                  <button className="link small" onClick={() => setRawResp(false)}>
                    표로 보기
                  </button>
                </div>
                <pre>{JSON.stringify(state.response, null, 2)}</pre>
              </div>
            ) : (
              <JsonBlock title="응답" data={state.response} />
            )
          ) : null}
        </div>
      ) : null}

      {footer ? <div className="step-midinput">{footer}</div> : null}
    </div>
  );
}

function JsonBlock({ title, data }: { title: string; data: unknown }) {
  return (
    <div className="json-block">
      <div className="json-title">{title}</div>
      <pre>{typeof data === "string" ? data : JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}
