import { useState, type ReactNode } from "react";

import type { StepExecutionState, StepResultView, StepStatus, WorkflowStep } from "../types";
import { ResultTable } from "./ResultTable";

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
  // 다른 업무를 연결한 스텝이면 그 도메인 색상 (테두리 + 이름 앞 불릿)
  accentColor?: string | null;
  // 응답 표시 방식 (표/원본 + 컬럼). 없으면 원본 JSON.
  resultView?: StepResultView;
  // 카드 하단 슬롯 — 중간 입력 폼 등. 있으면 카드를 펼친 채로 렌더한다.
  footer?: ReactNode;
}

/**
 * 스텝 카드 — 실행 상태를 색/아이콘으로 표시하고, 클릭 시 request/response 전체를
 * JSON 뷰어로 펼친다. 실행 화면과 히스토리 상세가 동일 컴포넌트를 재사용한다.
 */
export function StepCard({ step, state, accentColor, resultView, footer }: Props) {
  const [open, setOpen] = useState(false);
  // 표 모드로 설정돼 있으면 표를 기본으로, 필요 시 원본 JSON으로 토글
  const [rawResp, setRawResp] = useState(false);
  const status = state?.status ?? "PENDING";
  const meta = STATUS_META[status];
  const hasDetail = state?.request || state?.response || state?.error;
  const asTable = resultView?.mode === "TABLE";

  return (
    <div
      className={`step-card ${meta.cls} ${accentColor ? "linked" : ""}`}
      // 좌측 보더는 실행 상태 색을 유지하고, 나머지 3면을 도메인 색으로 감싼다
      style={
        accentColor
          ? { borderTopColor: accentColor, borderRightColor: accentColor, borderBottomColor: accentColor }
          : undefined
      }
    >
      <button
        className="step-head"
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="step-order">{step.order}</span>
        <span className="step-name">
          {accentColor ? <span className="task-bullet" style={{ background: accentColor }} /> : null}
          {step.name || `스텝 ${step.order}`}
        </span>
        <span className={`step-status ${meta.cls}`}>
          <span className="step-icon">{meta.icon}</span> {meta.label}
        </span>
        {hasDetail ? <span className="chevron">{open ? "▾" : "▸"}</span> : null}
      </button>

      {open && hasDetail ? (
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
                <ResultTable data={state.response} columns={resultView!.columns} />
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
