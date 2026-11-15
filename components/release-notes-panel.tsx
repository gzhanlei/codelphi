"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { RELEASE_NOTES } from "@/lib/ui-strings/product";
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

const statusEntries: Record<string, typeof RELEASE_NOTES.statusDraft> = { draft: RELEASE_NOTES.statusDraft, published: RELEASE_NOTES.statusPublished, unpublished: RELEASE_NOTES.statusUnpublished };
const kindEntries: Record<string, typeof RELEASE_NOTES.kindAdded> = { added: RELEASE_NOTES.kindAdded, changed: RELEASE_NOTES.kindChanged, removed: RELEASE_NOTES.kindRemoved };

function statusLabel(status: string, locale: UiLocale) {
  const entry = statusEntries[status];
  return entry ? pick(locale, entry) : status;
}

function blockTitle(block: { kind: string; featureName: string; scenarioReference: string; highlightType: string | null }, locale: UiLocale) {
  const kind = kindEntries[block.kind] ? pick(locale, kindEntries[block.kind]) : block.kind;
  const subject = block.scenarioReference ? `${block.featureName} · ${block.scenarioReference}` : block.featureName;
  return `${kind} · ${subject}${block.highlightType ? pick(locale, RELEASE_NOTES.highlightSuffix).replace("{type}", block.highlightType) : ""}`;
}

function CandidatePicker({ candidates, selected, onToggle, locale = "zh-CN" }: {
  candidates: ReleaseNoteChange[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  locale?: UiLocale;
}) {
  if (candidates.length === 0) return <p className="overview-note">{pick(locale, RELEASE_NOTES.noCandidates)}</p>;
  return (
    <div className="release-notes-pick">
      {candidates.map((candidate) => (
        <label className="release-notes-pick-item" key={candidate.id}>
          <input type="checkbox" checked={selected.has(candidate.id)} onChange={() => onToggle(candidate.id)} />
          <span>
            <strong>{blockTitle(candidate, locale)}</strong>
            <span className="release-notes-pick-summary">{candidate.summary}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function BlockEditor({ slug, noteId, block, canEdit, onSave, onReset, locale = "zh-CN" }: {
  slug: string;
  noteId: number;
  block: ReleaseNoteBlockView;
  canEdit: boolean;
  onSave: (position: number, summaryOverride: string) => void;
  onReset: (position: number) => void;
  locale?: UiLocale;
}) {
  const guard = useDemoGuard();
  const [value, setValue] = useState(block.summary);
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceError, setEnhanceError] = useState("");

  const enhance = async () => {
    if (guard()) return;
    setEnhancing(true);
    setEnhanceError("");
    try {
      const response = await fetch(`/api/products/${slug}/release-notes/${noteId}/enhance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: block.position }),
      });
      const data = await response.json() as { suggestion?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? pick(locale, RELEASE_NOTES.enhanceFailed));
      // 人在环：建议只替换文本框内容，失焦保存才落库
      setValue(data.suggestion ?? "");
    } catch (cause: unknown) {
      setEnhanceError(errorMessage(cause, pick(locale, RELEASE_NOTES.enhanceFailed)));
    } finally {
      setEnhancing(false);
    }
  };

  return (
    <div className="release-notes-block">
      <div className="release-notes-block-head">
        <strong>{blockTitle(block, locale)}</strong>
        {block.overridden ? <span className="drift-badge">{pick(locale, RELEASE_NOTES.overriddenBadge)} <button type="button" className="release-notes-reset" onClick={() => { setValue(block.summary); onReset(block.position); }}>{pick(locale, RELEASE_NOTES.resetOriginal)}</button></span> : null}
      </div>
      {canEdit ? (
        <>
          <textarea
            className="release-notes-summary"
            value={value}
            aria-label={pick(locale, RELEASE_NOTES.blockAria).replace("{title}", blockTitle(block, locale))}
            maxLength={4000}
            onChange={(event) => setValue(event.target.value)}
            onBlur={() => {
              if (value !== block.summary) onSave(block.position, value);
            }}
          />
          <button className="text-button" type="button" disabled={enhancing} onClick={() => void enhance()}>
            {enhancing ? pick(locale, RELEASE_NOTES.enhancing) : pick(locale, RELEASE_NOTES.enhance)}
          </button>
          {enhanceError ? <p className="description-dialog-error" role="alert">{enhanceError}</p> : null}
        </>
      ) : (
        <p>{value}</p>
      )}
      <EvidenceLinks value={block.evidencePaths.map((path) => ({ path }))} />
    </div>
  );
}

/** 发布稿动线（GTM 桥面批次 1）：勾选 → 生成草稿 → 块级校对 → 人工发布 → 公开链接/下线。 */
export function ReleaseNotesPanel({ slug, releaseId, canEdit, changelogHref, locale = "zh-CN" }: { slug: string; releaseId: number; canEdit: boolean; changelogHref?: string; locale?: UiLocale }) {
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
      const message = errorMessage(cause, pick(locale, RELEASE_NOTES.loadFailed));
      setLoadFailed(message === "未登录" ? pick(locale, RELEASE_NOTES.loginPromptPanel) : message);
    }
  }, [slug, releaseId, locale]);

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
      setError(errorMessage(cause, pick(locale, RELEASE_NOTES.operationFailed)));
    } finally {
      setPending(false);
    }
  };

  if (loadFailed) return <p className="overview-note">{pick(locale, RELEASE_NOTES.loadFailedPrefix).replace("{error}", loadFailed)}</p>;
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
    }, pick(locale, RELEASE_NOTES.noticeEmphasisSaved));

  const generate = () =>
    act(async () => {
      await generateDraft(slug, releaseId, [...selected], "");
      await load();
      setPicking(false);
    }, pick(locale, RELEASE_NOTES.noticeDraftGeneratedPanel));

  const publish = () =>
    act(async () => {
      if (!note) return;
      await setNoteStatus(slug, note.id, "publish");
      await load();
    }, pick(locale, RELEASE_NOTES.noticePublished));

  const unpublish = () =>
    act(async () => {
      if (!note) return;
      await setNoteStatus(slug, note.id, "unpublish");
      await load();
    }, pick(locale, RELEASE_NOTES.noticeUnpublished));

  const copyLink = (url: string) =>
    act(async () => {
      await navigator.clipboard.writeText(url);
    }, pick(locale, RELEASE_NOTES.noticeCopied));

  const editable = canEdit && note !== null && note.status !== "published";
  const published = note?.status === "published";

  return (
    <div className="behavior-section release-notes-section">
      <h3>
        {pick(locale, RELEASE_NOTES.panelHeading)}
        {note ? <span className={`release-notes-status ${note.status}`}>{statusLabel(note.status, locale)}</span> : null}
        {published && note?.publicUrl ? (
          <a className="overview-text-link" href={note.publicUrl} target="_blank" rel="noreferrer">{pick(locale, RELEASE_NOTES.publicPage)}</a>
        ) : null}
        {changelogHref ? <a className="overview-text-link" href={changelogHref} target="_blank" rel="noreferrer">{pick(locale, RELEASE_NOTES.changelog)}</a> : null}
        {note ? (
          <a className="overview-text-link" href={`/api/products/${slug}/releases/${releaseId}/release-notes/markdown`}>{pick(locale, RELEASE_NOTES.exportMarkdown)}</a>
        ) : null}
      </h3>
      {note === null ? (
        <>
          <p className="overview-note">{pick(locale, RELEASE_NOTES.pickPromptPanel)}</p>
          <CandidatePicker candidates={state.candidates} selected={selected} onToggle={toggle} locale={locale} />
          {canEdit ? (
            <button className="secondary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>
              {pick(locale, RELEASE_NOTES.generate)}{selected.size > 0 ? pick(locale, RELEASE_NOTES.generateSelected).replace("{count}", String(selected.size)) : ""}
            </button>
          ) : null}
        </>
      ) : (
        <>
          {note.emphasis || editable ? (
            <div className="release-notes-emphasis">
              <label htmlFor={`release-notes-emphasis-${releaseId}`}>{pick(locale, RELEASE_NOTES.emphasisLabel)}</label>
              <input
                id={`release-notes-emphasis-${releaseId}`}
                defaultValue={note.emphasis}
                readOnly={!editable || pending}
                placeholder={pick(locale, RELEASE_NOTES.emphasisPlaceholder)}
                onBlur={(event) => {
                  if (event.target.value !== note.emphasis) saveEmphasis(event.target.value);
                }}
              />
            </div>
          ) : null}
          {picking && editable ? (
            <>
              <p className="overview-note">{pick(locale, RELEASE_NOTES.regeneratePrompt)}</p>
              <CandidatePicker candidates={state.candidates} selected={selected} onToggle={toggle} locale={locale} />
              <div className="release-notes-actions">
                <button className="secondary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>{pick(locale, RELEASE_NOTES.regenerate)}</button>
                <button className="secondary-button" type="button" onClick={() => setPicking(false)}>{pick(locale, RELEASE_NOTES.cancel)}</button>
              </div>
            </>
          ) : (
            // 合并发布：草稿按功能分组校对（同一功能的多块相邻展示）
            [...new Set(state.blocks.map((block) => block.featureName))].map((featureName) => (
              <div className="release-notes-feature" key={featureName}>
                <h4 className="release-notes-feature-name">{featureName}</h4>
                {state.blocks.filter((block) => block.featureName === featureName).map((block) => (
                  <BlockEditor key={block.position} slug={slug} noteId={note.id} block={block} canEdit={editable} onSave={saveBlock} onReset={resetBlock} locale={locale} />
                ))}
              </div>
            ))
          )}
          <div className="release-notes-actions">
            {editable && !picking ? (
              <>
                <button className="primary-button" type="button" disabled={pending} onClick={publish}>{note.status === "unpublished" ? pick(locale, RELEASE_NOTES.republish) : pick(locale, RELEASE_NOTES.publish)}</button>
                <button className="secondary-button" type="button" disabled={pending} onClick={() => setPicking(true)}>{pick(locale, RELEASE_NOTES.adjustSelection)}</button>
              </>
            ) : null}
            {published && note.publicUrl ? <button className="secondary-button" type="button" disabled={pending} onClick={() => copyLink(note.publicUrl ?? "")}>{pick(locale, RELEASE_NOTES.copyLink)}</button> : null}
            {published && canEdit ? <button className="secondary-button" type="button" disabled={pending} onClick={unpublish}>{pick(locale, RELEASE_NOTES.unpublish)}</button> : null}
          </div>
          {published ? <p className="overview-note">{pick(locale, RELEASE_NOTES.publishedNote)}</p> : null}
        </>
      )}
      {notice ? <p className="description-dialog-error release-notes-notice" role="status">{notice}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}
