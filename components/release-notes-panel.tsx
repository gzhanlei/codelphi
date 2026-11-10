"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReleaseNoteBlockView, ReleaseNoteChange } from "@/lib/release-notes";
import { errorMessage } from "@/lib/error-message";
import {
  generateDraft,
  loadReleaseNote,
  saveNoteEdits,
  setNoteStatus,
  type ReleaseNoteState,
} from "@/lib/release-notes-client";
import { EvidenceLinks } from "./evidence-links";
import { useDemoGuard } from "./demo-mode";

const statusLabels: Record<string, string> = { draft: "草稿", published: "已发布", unpublished: "已下线" };
const kindLabels: Record<string, string> = { added: "新增", changed: "更新", removed: "移除" };

function blockTitle(block: { kind: string; featureName: string; scenarioReference: string; highlightType: string | null }) {
  const kind = kindLabels[block.kind] ?? block.kind;
  const subject = block.scenarioReference ? `${block.featureName} · ${block.scenarioReference}` : block.featureName;
  return `${kind} · ${subject}${block.highlightType ? `（${block.highlightType}）` : ""}`;
}

function CandidatePicker({ candidates, selected, onToggle }: {
  candidates: ReleaseNoteChange[];
  selected: Set<number>;
  onToggle: (id: number) => void;
}) {
  if (candidates.length === 0) return <p className="overview-note">本次发布没有行为变化，无可宣布项。</p>;
  return (
    <div className="release-notes-pick">
      {candidates.map((candidate) => (
        <label className="release-notes-pick-item" key={candidate.id}>
          <input type="checkbox" checked={selected.has(candidate.id)} onChange={() => onToggle(candidate.id)} />
          <span>
            <strong>{blockTitle(candidate)}</strong>
            <span className="release-notes-pick-summary">{candidate.summary}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function BlockEditor({ block, canEdit, onSave, onReset }: {
  block: ReleaseNoteBlockView;
  canEdit: boolean;
  onSave: (position: number, summaryOverride: string) => void;
  onReset: (position: number) => void;
}) {
  return (
    <div className="release-notes-block">
      <div className="release-notes-block-head">
        <strong>{blockTitle(block)}</strong>
        {block.overridden ? <span className="drift-badge">已人工改写 <button type="button" className="release-notes-reset" onClick={() => onReset(block.position)}>还原原文</button></span> : null}
      </div>
      {canEdit ? (
        <textarea
          className="release-notes-summary"
          defaultValue={block.summary}
          aria-label={`块文案：${blockTitle(block)}`}
          maxLength={4000}
          onBlur={(event) => {
            if (event.target.value !== block.summary) onSave(block.position, event.target.value);
          }}
        />
      ) : (
        <p>{block.summary}</p>
      )}
      <EvidenceLinks value={block.evidencePaths.map((path) => ({ path }))} />
    </div>
  );
}

/** 发布稿动线（GTM 桥面批次 1）：勾选 → 生成草稿 → 块级校对 → 人工发布 → 公开链接/下线。 */
export function ReleaseNotesPanel({ slug, releaseId, canEdit }: { slug: string; releaseId: number; canEdit: boolean }) {
  const guard = useDemoGuard();
  const [state, setState] = useState<ReleaseNoteState | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await loadReleaseNote(slug, releaseId);
      setState(data);
      setLoadFailed(null);
      // 不自动全选：仅预勾选带 Highlight 分类（安全/定价等宣布信号）的变更，可随时调整。
      setSelected(new Set(data.candidates.filter((candidate) => candidate.highlightType).map((candidate) => candidate.id)));
    } catch (cause: unknown) {
      const message = errorMessage(cause, "加载发布稿失败");
      setLoadFailed(message === "未登录" ? "登录后可在工作区生成并发布本版的发布稿。" : message);
    }
  }, [slug, releaseId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<void>, successNotice?: string) => {
    if (guard()) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await work();
      if (successNotice) setNotice(successNotice);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "操作失败"));
    } finally {
      setPending(false);
    }
  };

  if (loadFailed) return <p className="overview-note">发布稿：{loadFailed}</p>;
  if (!state) return null;
  const note = state.note;

  const toggle = (id: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const saveBlock = (position: number, summaryOverride: string) =>
    act(async () => {
      if (!note) return;
      await saveNoteEdits(slug, note.id, { blocks: [{ position, summaryOverride }] });
      await load();
    });

  const resetBlock = (position: number) =>
    act(async () => {
      if (!note) return;
      await saveNoteEdits(slug, note.id, { blocks: [{ position, summaryOverride: null }] });
      await load();
    });

  const saveEmphasis = (emphasis: string) =>
    act(async () => {
      if (!note) return;
      await saveNoteEdits(slug, note.id, { emphasis });
      await load();
    }, "强调语已保存");

  const generate = () =>
    act(async () => {
      await generateDraft(slug, releaseId, [...selected], "");
      await load();
      setPicking(false);
    }, "发布稿草稿已生成，逐块校对后发布");

  const publish = () =>
    act(async () => {
      if (!note) return;
      await setNoteStatus(slug, note.id, "publish");
      await load();
    }, "已发布，公开链接可分享");

  const unpublish = () =>
    act(async () => {
      if (!note) return;
      await setNoteStatus(slug, note.id, "unpublish");
      await load();
    }, "已下线，公开链接不再展示");

  const copyLink = (url: string) =>
    act(async () => {
      await navigator.clipboard.writeText(url);
    }, "公开链接已复制");

  const editable = canEdit && note !== null && note.status !== "published";
  const published = note?.status === "published";

  return (
    <div className="behavior-section release-notes-section">
      <h3>
        发布稿（客户向）
        {note ? <span className={`release-notes-status ${note.status}`}>{statusLabels[note.status] ?? note.status}</span> : null}
        {published && note?.publicUrl ? (
          <a className="overview-text-link" href={note.publicUrl} target="_blank" rel="noreferrer">公开页 ↗</a>
        ) : null}
        {note ? (
          <a className="overview-text-link" href={`/api/products/${slug}/releases/${releaseId}/release-notes/markdown`}>导出 Markdown ↓</a>
        ) : null}
      </h3>
      {note === null ? (
        <>
          <p className="overview-note">勾选要宣布的变更（不自动全选），生成客户向发布稿草稿；每条都锚定规格变更并附证据。</p>
          <CandidatePicker candidates={state.candidates} selected={selected} onToggle={toggle} />
          {canEdit ? (
            <button className="secondary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>
              生成发布稿{selected.size > 0 ? `（已选 ${selected.size} 条）` : ""}
            </button>
          ) : null}
        </>
      ) : (
        <>
          {note.emphasis || editable ? (
            <div className="release-notes-emphasis">
              <label htmlFor={`release-notes-emphasis-${releaseId}`}>重点强调（可选）</label>
              <input
                id={`release-notes-emphasis-${releaseId}`}
                defaultValue={note.emphasis}
                readOnly={!editable || pending}
                placeholder="一句话强调本次发布的重点"
                onBlur={(event) => {
                  if (event.target.value !== note.emphasis) saveEmphasis(event.target.value);
                }}
              />
            </div>
          ) : null}
          {picking && editable ? (
            <>
              <p className="overview-note">调整勾选后重新生成（覆盖当前草稿与块级改写）：</p>
              <CandidatePicker candidates={state.candidates} selected={selected} onToggle={toggle} />
              <div className="release-notes-actions">
                <button className="secondary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>按勾选重新生成</button>
                <button className="secondary-button" type="button" onClick={() => setPicking(false)}>取消</button>
              </div>
            </>
          ) : (
            state.blocks.map((block) => (
              <BlockEditor key={block.position} block={block} canEdit={editable} onSave={saveBlock} onReset={resetBlock} />
            ))
          )}
          <div className="release-notes-actions">
            {editable && !picking ? (
              <>
                <button className="primary-button" type="button" disabled={pending} onClick={publish}>{note.status === "unpublished" ? "重新发布" : "发布"}</button>
                <button className="secondary-button" type="button" disabled={pending} onClick={() => setPicking(true)}>调整勾选</button>
              </>
            ) : null}
            {published && note.publicUrl ? <button className="secondary-button" type="button" disabled={pending} onClick={() => copyLink(note.publicUrl ?? "")}>复制公开链接</button> : null}
            {published && canEdit ? <button className="secondary-button" type="button" disabled={pending} onClick={unpublish}>下线</button> : null}
          </div>
          {published ? <p className="overview-note">已发布只读：先下线才能修改或重新生成；公开页对匿名可见，证据仅展示路径。</p> : null}
        </>
      )}
      {notice ? <p className="description-dialog-error release-notes-notice" role="status">{notice}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}
