"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { REPO_TRIGGER, SETTINGS_COMMON, TRIGGER_MODES } from "@/lib/ui-strings/workspace";
import { TRIGGER_MODE_HINTS, TRIGGER_MODE_LABELS } from "./workspace-trigger-default-settings";
import { updateRepositoryTrigger } from "@/lib/product-client";
import type { AnalysisTriggerMode } from "@/lib/analysis-trigger";

export interface RepositoryTriggerRow {
  id: number;
  owner: string;
  name: string;
  triggerMode: AnalysisTriggerMode;
  n: number | null;
  hour: number | null;
  pendingPushCount: number;
}

const TRIGGER_HOURS = [0, 1, 2, 3, 4, 5, 6, 22, 23];

/** 设置页 · 分析触发模式：按仓库选择消耗节奏（每次 push / 每天低峰 / 每 N 次 + 当天兜底）。 */
export function RepositoryTriggerSettings({ slug, repos, canEdit, locale = "zh-CN" }: { slug: string; repos: RepositoryTriggerRow[]; canEdit: boolean; locale?: UiLocale }) {
  const L = REPO_TRIGGER;
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<number, { trigger: AnalysisTriggerMode; n: number; hour: number }>>(() =>
    Object.fromEntries(repos.map((repo) => [repo.id, { trigger: repo.triggerMode, n: repo.n ?? 5, hour: repo.hour ?? 3 }])),
  );
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<Record<number, string>>({});

  if (!canEdit) return null;
  if (repos.length === 0) return null;

  const updateDraft = (id: number, patch: Partial<{ trigger: AnalysisTriggerMode; n: number; hour: number }>) => {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  };

  const save = async (repo: RepositoryTriggerRow) => {
    const draft = drafts[repo.id];
    if (!draft) return;
    setPendingId(repo.id);
    setError((current) => ({ ...current, [repo.id]: "" }));
    setNotice((current) => ({ ...current, [repo.id]: "" }));
    try {
      await updateRepositoryTrigger(slug, repo.id, { trigger: draft.trigger, n: draft.n, hour: draft.hour });
      setNotice((current) => ({ ...current, [repo.id]: pick(locale, L.savedNotice) }));
      router.refresh();
    } catch (cause: unknown) {
      setError((current) => ({ ...current, [repo.id]: errorMessage(cause, "保存分析触发设置失败") }));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>05</span><h2>{pick(locale, L.heading)}</h2></div>
      <p className="overview-note">{pick(locale, L.note)}</p>
      {repos.map((repo) => {
        const draft = drafts[repo.id] ?? { trigger: repo.triggerMode, n: repo.n ?? 5, hour: repo.hour ?? 3 };
        return (
          <div key={repo.id} className="settings-form" style={{ marginBottom: 16 }}>
            <p className="overview-note" style={{ fontWeight: 600 }}>{repo.owner}/{repo.name}</p>
            <div role="radiogroup" aria-label={`${pick(locale, L.modeAriaPrefix)}${repo.name}`} style={{ margin: "0 0 12px" }}>
              {(Object.keys(TRIGGER_MODE_LABELS) as AnalysisTriggerMode[]).map((mode) => (
                <label key={mode} style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", cursor: pendingId === repo.id ? "wait" : "pointer" }}>
                  <input
                    type="radio"
                    name={`repository-trigger-${repo.id}`}
                    value={mode}
                    checked={draft.trigger === mode}
                    disabled={pendingId === repo.id}
                    onChange={() => updateDraft(repo.id, { trigger: mode })}
                  />
                  <span style={{ fontSize: 14 }}>{pick(locale, TRIGGER_MODE_LABELS[mode])}</span>
                </label>
              ))}
            </div>
            {draft.trigger === "push_count" ? (
              <label className="field">
                <span>{pick(locale, TRIGGER_MODES.countLabel)}</span>
                <select aria-label={`${pick(locale, L.countAriaPrefix)}${repo.name}`} value={draft.n} disabled={pendingId === repo.id} onChange={(event) => updateDraft(repo.id, { n: Number(event.target.value) })}>
                  {[3, 5, 10].map((value) => <option key={value} value={value}>{value}{pick(locale, TRIGGER_MODES.pushCountUnit)}</option>)}
                </select>
              </label>
            ) : null}
            {draft.trigger !== "push" ? (
              <label className="field">
                <span>{pick(locale, TRIGGER_MODES.hourLabel)}</span>
                <select aria-label={`${pick(locale, L.hourAriaPrefix)}${repo.name}`} value={draft.hour} disabled={pendingId === repo.id} onChange={(event) => updateDraft(repo.id, { hour: Number(event.target.value) })}>
                  {TRIGGER_HOURS.map((value) => <option key={value} value={value}>{String(value).padStart(2, "0")}:00</option>)}
                </select>
              </label>
            ) : null}
            <p className="overview-note">{pick(locale, TRIGGER_MODE_HINTS[draft.trigger])}{repo.pendingPushCount > 0 && draft.trigger !== "push" ? `${pick(locale, L.pendingPushesPrefix)}${repo.pendingPushCount}${pick(locale, L.pendingPushesMiddle)}` : ""}</p>
            <button className="secondary-button" type="button" onClick={() => void save(repo)} disabled={pendingId === repo.id}>
              {pendingId === repo.id ? pick(locale, SETTINGS_COMMON.saving) : pick(locale, SETTINGS_COMMON.save)}
            </button>
            {error[repo.id] ? <p className="description-dialog-error" role="alert">{error[repo.id]}</p> : null}
            {notice[repo.id] && !error[repo.id] ? <p className="form-success" role="status">{notice[repo.id]}</p> : null}
          </div>
        );
      })}
    </section>
  );
}
