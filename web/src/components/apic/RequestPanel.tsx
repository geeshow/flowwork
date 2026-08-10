import { useState } from "react";

import { api } from "../../api/client";
import {
  activeEnvVars,
  buildResolvedRequest,
  outputLabel,
  outputName,
  type ApicBodyMode,
  type ApicCollection,
  type ApicOutputField,
  type ApicRequest,
} from "../../types/apic";
import { KVEditor } from "./KVEditor";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/**
 * 응답 필드(output) 편집기 — 필드명 + 한글 설명(라벨).
 * 워크플로우의 결과 표·응답 필드 표시에서 설명이 있으면 설명을, 없으면 필드명을 쓴다.
 */
function OutputEditor({
  output,
  onChange,
}: {
  output: ApicOutputField[];
  onChange: (output: ApicOutputField[]) => void;
}) {
  const patch = (i: number, name: string, label: string) =>
    onChange(output.map((f, j) => (j === i ? (label ? { name, label } : name) : f)));

  return (
    <div className="kv-editor">
      {output.map((f, i) => (
        <div key={i} className="kv-row">
          <input
            className="kv-name"
            value={outputName(f)}
            placeholder="필드명 (예: accountNo)"
            onChange={(e) => patch(i, e.target.value, outputLabel(f) ?? "")}
          />
          <input
            className="kv-value"
            value={outputLabel(f) ?? ""}
            placeholder="한글 설명 (예: 계좌번호)"
            onChange={(e) => patch(i, outputName(f), e.target.value)}
          />
          <button
            className="icon-btn danger"
            onClick={() => onChange(output.filter((_, j) => j !== i))}
            title="삭제"
          >
            ✕
          </button>
        </div>
      ))}
      <button className="link small" onClick={() => onChange([...output, ""])}>
        + 추가
      </button>
      <p className="hint">API 응답 명세 필드입니다. 설명은 워크플로우의 결과 표 헤더 등에 사용됩니다.</p>
    </div>
  );
}

interface SendResult {
  status: number | null;
  elapsedMs?: number;
  body: unknown;
}

function prettyBody(body: unknown): string {
  // 프록시는 JSON이 아닌 응답을 {_raw: text}로 감싼다 — 원문 그대로 보여준다.
  if (body && typeof body === "object" && "_raw" in (body as Record<string, unknown>)) {
    return String((body as Record<string, unknown>)._raw);
  }
  return JSON.stringify(body, null, 2);
}

/** 요청 이름·메서드·URL 편집 + 파라미터/헤더/바디 탭 + 전송/응답 패널. */
export function RequestPanel({
  doc,
  name,
  request,
  onChangeName,
  onChangeRequest,
  onChangeActiveEnv,
}: {
  doc: ApicCollection;
  name: string;
  request: ApicRequest;
  onChangeName: (name: string) => void;
  onChangeRequest: (request: ApicRequest) => void;
  onChangeActiveEnv: (envName: string | null) => void;
}) {
  const [tab, setTab] = useState<"params" | "headers" | "body" | "output">("params");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const patch = (p: Partial<ApicRequest>) => onChangeRequest({ ...request, ...p });

  async function send() {
    setSending(true);
    setSendError(null);
    setResult(null);
    try {
      const resolved = buildResolvedRequest(request, activeEnvVars(doc));
      const started = performance.now();
      const r = (await api.invoke(resolved)) as {
        response: { status: number | null; body: unknown };
        elapsed_ms?: number;
      };
      setResult({
        status: r.response.status,
        elapsedMs: r.elapsed_ms ?? Math.round(performance.now() - started),
        body: r.response.body,
      });
    } catch (e) {
      setSendError(
        e instanceof SyntaxError ? `JSON 바디 파싱 실패: ${e.message}` : (e as Error).message,
      );
    } finally {
      setSending(false);
    }
  }

  const statusClass =
    result?.status && result.status >= 200 && result.status < 300 ? "success" : "failed";

  return (
    <section className="apic-request">
      <div className="apic-request-head">
        <input
          className="apic-name-input"
          value={name}
          onChange={(e) => onChangeName(e.target.value)}
          placeholder="요청 이름"
        />
        <label className="apic-env-select">
          <span className="muted">환경</span>
          <select
            value={doc.activeEnvironment ?? ""}
            onChange={(e) => onChangeActiveEnv(e.target.value || null)}
          >
            <option value="">(없음)</option>
            {doc.environments.map((env) => (
              <option key={env.name} value={env.name}>
                {env.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="apic-url-row">
        <select
          className={`apic-method method-${request.method.toLowerCase()}`}
          value={request.method}
          onChange={(e) => patch({ method: e.target.value })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          className="apic-url"
          value={request.url}
          onChange={(e) => patch({ url: e.target.value })}
          placeholder="{{baseUrl}}/path 또는 http://…"
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />
        <button className="primary" onClick={() => void send()} disabled={sending}>
          {sending ? "전송 중…" : "전송"}
        </button>
      </div>

      <div className="apic-tabs">
        {(
          [
            ["params", `파라미터${request.params.length ? ` (${request.params.length})` : ""}`],
            ["headers", `헤더${request.headers.length ? ` (${request.headers.length})` : ""}`],
            ["body", "바디"],
            ["output", `응답필드${request.output?.length ? ` (${request.output.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "params" ? (
        <KVEditor
          rows={request.params}
          withKind
          onChange={(params) => patch({ params })}
          namePlaceholder="파라미터명"
        />
      ) : null}
      {tab === "headers" ? (
        <KVEditor
          rows={request.headers}
          onChange={(headers) => patch({ headers })}
          namePlaceholder="헤더명"
        />
      ) : null}
      {tab === "body" ? (
        <div className="apic-body">
          <div className="apic-body-modes">
            {(["none", "json", "text"] as ApicBodyMode[]).map((mode) => (
              <label key={mode}>
                <input
                  type="radio"
                  checked={request.body.mode === mode}
                  onChange={() => patch({ body: { ...request.body, mode } })}
                />
                {mode === "none" ? "없음" : mode.toUpperCase()}
              </label>
            ))}
          </div>
          {request.body.mode !== "none" ? (
            <textarea
              className="apic-body-text"
              rows={8}
              value={
                request.body.mode === "json" ? (request.body.json ?? "") : (request.body.text ?? "")
              }
              onChange={(e) =>
                patch({
                  body:
                    request.body.mode === "json"
                      ? { ...request.body, json: e.target.value }
                      : { ...request.body, text: e.target.value },
                })
              }
              placeholder={request.body.mode === "json" ? '{"key": "{{변수}}"}' : "텍스트 바디"}
              spellCheck={false}
            />
          ) : null}
        </div>
      ) : null}

      {tab === "output" ? (
        <OutputEditor
          output={request.output ?? []}
          onChange={(output) => patch({ output: output.length ? output : undefined })}
        />
      ) : null}

      {sendError ? <div className="error-banner">{sendError}</div> : null}
      {result ? (
        <div className="apic-response">
          <div className="apic-response-meta">
            <span className={`apic-status ${statusClass}`}>
              {result.status ?? "네트워크 오류"}
            </span>
            {result.elapsedMs != null ? (
              <span className="muted">{result.elapsedMs}ms</span>
            ) : null}
          </div>
          <pre className="apic-response-body">{prettyBody(result.body)}</pre>
        </div>
      ) : null}
    </section>
  );
}
