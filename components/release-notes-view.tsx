"use client";

import { useCallback, useEffect, useState } from "react";
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
  candidates: Array<{ id: number; kind: string; featureName: string; scenarioReference: string; summary: string; highlightType: string | null }>;
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

function BlockRow({ block, canEdit, onSave, onReset }: {
  block: ReleaseNoteState["blocks"][number];
  canEdit: boolean;
  onSave: (position: number, summaryOverride: string) => void;
  onReset: (position: number) => void;
}) {
  const [value, setValue] = useState(block.summary);
  useEffect(() => setValue(block.summary), [block.summary]);
  return (
    <div className="release-notes-block">
      <div className="release-notes-block-head">
        <strong>{blockTitle(block)}</strong>
        {block.overridden ? <span className="drift-badge">已人工改写 <button type="button" className="release-notes-reset" onClick={() => { setValue(block.summary); onReset(block.position); }}>还原原文</button></span> : null}
      </div>
      {canEdit ? (
        <textarea
          className="release-notes-summary"
          value={value}
          aria-label={`块文案：${blockTitle(block)}`}
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
export function ReleaseNotesView({ slug, releaseId, canEdit, changelogHref }: {
  slug: string;
  releaseId: number;
  canEdit: boolean;
  changelogHref?: string;
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
      const message = errorMessage(cause, "加载发布稿失败");
      setLoadFailed(message === "未登录" ? "登录后可在工作区生成并发布发布稿。" : message);
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
    }, "强调语已保存");

  const generate = () =>
    act(async () => {
      await generateDraft(slug, releaseId, [...selected], "");
      await load();
      setPicking(false);
    }, "发布稿草稿已生成");

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

  // 按功能分组展示（合并发布：一次发布跨多功能）
  const featureOrder = [...new Set(state.blocks.map((block) => block.featureName))];

  return (
    <div className="release-notes-view">
      <div className="page-heading">
        <div><span className="eyebrow">RELEASE NOTES</span><h1>发布稿</h1><p>最新一次发布（release #{releaseId}）的客户向说明。每块锚定规格变更与证据，人工校对并发布后生成公开页。</p></div>
        {published && note?.publicUrl ? <div className="page-actions"><a className="primary-button" href={note.publicUrl} target="_blank" rel="noreferrer">公开页 ↗</a></div> : null}
      </div>
      {note === null ? (
        <>
          <p className="overview-note">勾选本次发布要宣布的变更（不自动全选），生成发布稿草稿。</p>
          <CandidatePicker candidates={state.candidates} selected={selected} onToggle={toggle} />
          {canEdit ? (
            <button className="primary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>
              生成发布稿{selected.size > 0 ? `（已选 ${selected.size} 条）` : ""}
            </button>
          ) : null}
        </>
      ) : (
        <>
          {note.emphasis || editable ? (
            <div className="release-notes-emphasis">
              <label htmlFor={`notes-emphasis-${releaseId}`}>重点强调（可选）</label>
              <input
                id={`notes-emphasis-${releaseId}`}
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
                <button className="primary-button" type="button" disabled={pending || selected.size === 0} onClick={generate}>按勾选重新生成</button>
                <button className="secondary-button" type="button" onClick={() => setPicking(false)}>取消</button>
              </div>
            </>
          ) : (
            featureOrder.map((featureName) => (
              <div className="release-notes-feature" key={featureName}>
                <h4 className="release-notes-feature-name">{featureName}</h4>
                {state.blocks.filter((block) => block.featureName === featureName).map((block) => (
                  <BlockRow key={block.position} block={block} canEdit={editable} onSave={saveBlock} onReset={resetBlock} />
                ))}
              </div>
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
          <div className="release-notes-actions">
            <a className="overview-text-link" href={`/api/products/${slug}/releases/${releaseId}/release-notes/markdown`}>导出 Markdown ↓</a>
            {changelogHref ? <a className="overview-text-link" href={changelogHref} target="_blank" rel="noreferrer">公开变更日志 ↗</a> : null}
          </div>
        </>
      )}
      {notice ? <p className="description-dialog-error release-notes-notice" role="status">{notice}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}
