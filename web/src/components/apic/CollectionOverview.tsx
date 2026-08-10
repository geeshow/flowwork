import { useState } from "react";

import { api } from "../../api/client";
import type { ApicCollection, ApicParam } from "../../types/apic";
import { KVEditor } from "./KVEditor";

function download(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 콜렉션 이름·환경(변수) 관리 + Bruno/Postman 내보내기 + 삭제. */
export function CollectionOverview({
  ws,
  doc,
  onChange,
  onDelete,
}: {
  ws: string;
  doc: ApicCollection;
  onChange: (doc: ApicCollection) => void;
  onDelete: () => void;
}) {
  const [envSel, setEnvSel] = useState<string | null>(doc.environments[0]?.name ?? null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const env = doc.environments.find((e) => e.name === envSel) ?? null;

  // GitHub 연결 콜렉션 동기화 — 레포 최신 내용으로 갱신 (id 유지 → 워크플로우 참조 보존)
  async function syncFromGithub() {
    setSyncing(true);
    setError(null);
    setSyncedAt(null);
    try {
      const updated = await api.apicSyncCollection(ws, doc.id);
      onChange(updated);
      setSyncedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function exportAs(format: "bruno" | "postman") {
    setError(null);
    try {
      const data = await api.apicExportCollection(ws, doc.id, format);
      download(
        format === "bruno" ? `${doc.name}.json` : `${doc.name}.postman_collection.json`,
        data,
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function addEnv() {
    const name = window.prompt("환경 이름 (예: dev, stage)");
    if (!name?.trim()) return;
    if (doc.environments.some((e) => e.name === name.trim())) {
      setError(`이미 존재하는 환경입니다: ${name.trim()}`);
      return;
    }
    const next = { name: name.trim(), variables: [] };
    onChange({
      ...doc,
      environments: [...doc.environments, next],
      activeEnvironment: doc.activeEnvironment ?? next.name,
    });
    setEnvSel(next.name);
  }

  function deleteEnv(name: string) {
    if (!window.confirm(`환경 '${name}'을(를) 삭제할까요?`)) return;
    const environments = doc.environments.filter((e) => e.name !== name);
    onChange({
      ...doc,
      environments,
      activeEnvironment: doc.activeEnvironment === name ? (environments[0]?.name ?? null) : doc.activeEnvironment,
    });
    setEnvSel(environments[0]?.name ?? null);
  }

  return (
    <section className="apic-overview">
      <div className="apic-overview-head">
        <input
          className="apic-name-input"
          value={doc.name}
          onChange={(e) => onChange({ ...doc, name: e.target.value })}
          placeholder="콜렉션 이름"
        />
        <div className="apic-overview-actions">
          <button className="link small" onClick={() => void exportAs("bruno")}>
            내보내기(Bruno)
          </button>
          <button className="link small" onClick={() => void exportAs("postman")}>
            내보내기(Postman)
          </button>
          <button
            className="link small danger"
            onClick={() => {
              if (window.confirm(`콜렉션 '${doc.name}'을(를) 삭제할까요?`)) onDelete();
            }}
          >
            삭제
          </button>
        </div>
      </div>

      {doc.source?.type === "github" ? (
        <div className="apic-source-bar">
          <span className="muted">
            GitHub 연결됨: <code>{doc.source.url}</code>
          </span>
          <button className="link small" onClick={() => void syncFromGithub()} disabled={syncing}>
            {syncing ? "동기화 중…" : "⟳ 동기화"}
          </button>
          {syncedAt ? <span className="hint ok-text">✓ {syncedAt} 동기화됨</span> : null}
        </div>
      ) : null}

      {error ? <div className="error-banner">{error}</div> : null}

      <div className="panel">
        <h3>환경변수</h3>
        <div className="apic-env-bar">
          {doc.environments.map((e) => (
            <button
              key={e.name}
              className={`apic-env-chip ${envSel === e.name ? "active" : ""}`}
              onClick={() => setEnvSel(e.name)}
            >
              {e.name}
              {doc.activeEnvironment === e.name ? " ✓" : ""}
            </button>
          ))}
          <button className="link small" onClick={addEnv}>
            + 환경
          </button>
        </div>

        {env ? (
          <>
            <div className="apic-env-actions">
              <label>
                <input
                  type="radio"
                  checked={doc.activeEnvironment === env.name}
                  onChange={() => onChange({ ...doc, activeEnvironment: env.name })}
                />
                활성 환경으로 사용
              </label>
              <button className="link small danger" onClick={() => deleteEnv(env.name)}>
                환경 삭제
              </button>
            </div>
            <KVEditor
              rows={env.variables as ApicParam[]}
              onChange={(variables) =>
                onChange({
                  ...doc,
                  environments: doc.environments.map((e) =>
                    e.name === env.name ? { ...e, variables } : e,
                  ),
                })
              }
              namePlaceholder="변수명"
            />
          </>
        ) : (
          <p className="muted">환경이 없습니다. {"{{변수}}"} 치환을 쓰려면 환경을 추가하세요.</p>
        )}
      </div>

      <p className="hint">
        왼쪽 트리에서 요청을 선택하면 편집·전송할 수 있습니다. 요청 URL·헤더·바디에서{" "}
        {"{{변수}}"}는 활성 환경 값으로 치환됩니다.
      </p>
    </section>
  );
}
