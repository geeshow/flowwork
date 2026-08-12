import { useCallback, useEffect, useMemo, useState } from "react";

import {
  api,
  setEditBranch,
  type EditFileEntry,
  type EditState,
} from "../../api/client";
import { EditBar } from "../edit/EditBar";
import { ApiClientPage } from "./ApiClientPage";

/**
 * API 콜렉션 화면의 브랜치 편집 셸 — 워크플로우 편집 메뉴와 동일한 플로우.
 *
 * - /apic (develop, 읽기 전용) ↔ /apic/b/{branch}/… (수정 모드)
 * - 상단 EditBar에서 브랜치 생성/전환·커밋·푸시·develop 머지를 수행하고,
 *   콜렉션 트리에는 develop 대비 파일 상태 배지를 표시한다.
 */
export function ApicShell({
  ws,
  branch,
  go,
}: {
  ws?: string;
  branch?: string;
  go: (path: string) => void;
}) {
  const urlBranch = branch ?? null; // null = develop 기본
  setEditBranch(urlBranch);
  const bp = urlBranch ? `/apic/b/${encodeURIComponent(urlBranch)}` : "/apic";

  const [st, setSt] = useState<EditState | null>(null);
  const [files, setFiles] = useState<EditFileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const bump = useCallback(() => setRefresh((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    setEditBranch(urlBranch);
    Promise.all([api.editState(), api.editStatus()])
      .then(([s, f]) => {
        if (!alive) return;
        setSt(s);
        setFiles(f.files);
        setError(null);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [refresh, urlBranch]);

  // 콜렉션 id → 파일 상태 (트리 배지)
  const collectionStates = useMemo(() => {
    const map = new Map<string, EditFileEntry>();
    for (const f of files) if (f.kind === "collection" && f.id) map.set(f.id, f);
    return map;
  }, [files]);

  async function run(op: () => Promise<unknown>, done?: string) {
    setError(null);
    setNotice(null);
    try {
      await op();
      if (done) setNotice(done);
      bump();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="edit-shell">
      <EditBar st={st} files={files} go={go} onAction={run} urlBranch={urlBranch} basePath="/apic" />
      {error ? <div className="error-banner">{error}</div> : null}
      {notice ? <div className="notice-banner">{notice}</div> : null}
      <ApiClientPage
        key={`${urlBranch ?? ""}:${st?.branch ?? ""}`}
        ws={ws}
        canEdit={urlBranch != null}
        collectionStates={collectionStates}
        onChanged={bump}
        onSelectWs={(w) => go(w ? `${bp}/${encodeURIComponent(w)}` : bp)}
      />
    </div>
  );
}
