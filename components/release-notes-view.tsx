"use client";

import { useCallback, useEffect, useState } from "react";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { RELEASE_NOTES } from "@/lib/ui-strings/product";
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
  candidates: Array<{ id: number; kind: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null }>;
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

function BlockRow({ block, canEdit, onSave, onReset, locale = "zh-CN" }: {
  block: ReleaseNoteState["blocks"][number];
  canEdit: boolean;
  onSave: (position: number, summaryOverride: string) => void;
  onReset: (position: number) => void;
  locale?: UiLocale;
}) {
  const [value, setValue] = useState(block.summary);
  useEffect(() => setValue(block.summary), [block.summary]);
  return (
    <div className="release-notes-block">
      <div className="release-notes-block-head">
        <strong>{blockTitle(block, locale)}</strong>
        {block.overridden ? <span className="drift-badge">{pick(locale, RELEASE_NOTES.overriddenBadge)} <button type="button" className="release-notes-reset" onClick={() => { setValue(block.summary); onReset(block.position); }}>{pick(locale, RELEASE_NOTES.resetOriginal)}</button></span> : null}
      </div>
      {canEdit ? (
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
      ) : (
        <p>{block.summary}</p>
      )}
      <EvidenceLinks value={block.evidencePaths.map((path) => ({ path }))} />
    </div>
  );
}

/** 发布稿一级视图（?view=notes，Specsight 的 Release notes tab 对位）：草稿校对与发布都在这里，全宽。 */
export function ReleaseNotesView({ slug, releaseId, canEdit, changelogHref, locale = "zh-CN" }: {
  slug: string;
  releaseId: number;
  canEdit: boolean;
  changelogHref?: string;
  locale?: UiLocale;
}) {
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
      // 不自动全选：仅预勾选带 Highlight 分类的变更，可随时调整
      setSelected(new Set(data.candidates.filter((candidate) => candidate.highlightType).map((candidate) => candidate.id)));
    } catch (cause: unknown) {
      const message = errorMessage(cause, pick(locale, RELEASE_NOTES.loadFailed));
      setLoadFailed(message === "未登录" ? pick(locale, RELEASE_NOTES.loginPrompt) : message);
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
  const editable = canEdit && note !== null && note.status !== "published";
  const published = note?.status === "published";

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
    }, pick(locale, RELEASE_NOTES.noticeDraftGenerated));

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

  // 按功能分组展示（合并发布：一次发布跨多功能）
  const featureOrder = [...new Set(state.blocks.map((block) => block.featureName))];

  return (
    <div className="release-notes-view">
      <div className="page-heading">
        <div><span className="eyebrow">RELEASE NOTES</span><h1>{pick(locale, RELEASE_NOTES.heading)}</h1><p>{pick(locale, RELEASE_NOTES.headingDescription).replace("{id}", String(releaseId))}</p></div>
        {published && note?.publicUrl ? <div className="page-actions"><a className="primary-button" href={note.publicUrl} target="_blank" rel="noreferrer">{pick(locale, RELEASE_NOTES.publicPage)}</a></div> : null}
      </div>
      {note === null ? (
        <>
          <p className="overview-note">{pick(locale, RELEASE_NOTES.pickPrompt)}</p>
          <CandidatePicker candidates={state.candidates} selected={selected} onToggle={toggle} locale={locale} />
          {canEdit ? (
            <button className="primary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>
              {pick(locale, RELEASE_NOTES.generate)}{selected.size > 0 ? pick(locale, RELEASE_NOTES.generateSelected).replace("{count}", String(selected.size)) : ""}
            </button>
          ) : null}
        </>
      ) : (
        <>
          {editable ? (
            <div className="release-notes-emphasis">
              <label htmlFor={`notes-headline-${releaseId}`}>{pick(locale, RELEASE_NOTES.headlineLabel)}</label>
              <input
                id={`notes-headline-${releaseId}`}
                defaultValue={note.headline ?? ""}
                readOnly={!editable || pending}
                placeholder={pick(locale, RELEASE_NOTES.headlinePlaceholder)}
                onBlur={(event) => {
                  if (event.target.value !== (note.headline ?? "")) act(async () => {
                    await saveNoteEdits(slug, note.id, { headline: event.target.value });
                    await load();
                  }, pick(locale, RELEASE_NOTES.noticeHeadlineSaved));
                }}
              />
            </div>
          ) : note.headline ? <h2 className="notes-headline">{note.headline}</h2> : null}
          {note.emphasis || editable ? (
            <div className="release-notes-emphasis">
              <label htmlFor={`notes-emphasis-${releaseId}`}>{pick(locale, RELEASE_NOTES.emphasisLabel)}</label>
              <input
                id={`notes-emphasis-${releaseId}`}
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
                <button className="primary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>{pick(locale, RELEASE_NOTES.regenerate)}</button>
                <button className="secondary-button" type="button" onClick={() => setPicking(false)}>{pick(locale, RELEASE_NOTES.cancel)}</button>
              </div>
            </>
          ) : (
            featureOrder.map((featureName) => (
              <div className="release-notes-feature" key={featureName}>
                <h4 className="release-notes-feature-name">{featureName}</h4>
                {state.blocks.filter((block) => block.featureName === featureName).map((block) => (
                  <BlockRow key={block.position} block={block} canEdit={editable} onSave={saveBlock} onReset={resetBlock} locale={locale} />
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
          <div className="release-notes-actions">
            <a className="overview-text-link" href={`/api/products/${slug}/releases/${releaseId}/release-notes/markdown`}>{pick(locale, RELEASE_NOTES.exportMarkdown)}</a>
            {changelogHref ? <a className="overview-text-link" href={changelogHref} target="_blank" rel="noreferrer">{pick(locale, RELEASE_NOTES.changelog)}</a> : null}
          </div>
        </>
      )}
      {notice ? <p className="description-dialog-error release-notes-notice" role="status">{notice}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}
