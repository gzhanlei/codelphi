"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { pick, type LocaleEntry, type UiLocale } from "@/lib/ui-locale";
import { SETTINGS_COMMON, TRIGGER_MODES, WORKSPACE_TRIGGER } from "@/lib/ui-strings/workspace";
import type { AnalysisTriggerMode } from "@/lib/analysis-trigger";

/** 触发模式标签与提示（zh 槽位与原硬编码逐字一致；repository-trigger-settings 共用）。 */
export const TRIGGER_MODE_LABELS: Record<AnalysisTriggerMode, LocaleEntry> = {
  push: TRIGGER_MODES.push,
  daily: TRIGGER_MODES.daily,
  push_count: TRIGGER_MODES.pushCount,
};
export const TRIGGER_MODE_HINTS: Record<AnalysisTriggerMode, LocaleEntry> = {
  push: TRIGGER_MODES.pushHint,
  daily: TRIGGER_MODES.dailyHint,
  push_count: TRIGGER_MODES.pushCountHint,
};

/** 设置页 · 工作区默认触发模式：新接入的仓库继承此设置，已有仓库不受影响。 */
export function WorkspaceTriggerDefaultSettings({ canEdit, current, locale = "zh-CN" }: { canEdit: boolean; current: { trigger: AnalysisTriggerMode; n: number | null; hour: number | null }; locale?: UiLocale }) {
  const router = useRouter();
  const [draft, setDraft] = useState<{ trigger: AnalysisTriggerMode; n: number; hour: number }>({
    trigger: current.trigger,
    n: current.n ?? 5,
    hour: current.hour ?? 3,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!canEdit) return null;

  const save = async () => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/settings/analysis-trigger-default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await response.json() as { status?: string; error?: string };
      if (!response.ok || data.status !== "updated") throw new Error(data.error ?? "保存默认触发设置失败");
      setNotice(pick(locale, WORKSPACE_TRIGGER.savedNotice));
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存默认触发设置失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>02</span><h2>{pick(locale, WORKSPACE_TRIGGER.heading)}</h2></div>
      <p className="overview-note">{pick(locale, WORKSPACE_TRIGGER.note)}</p>
      <div className="settings-form">
        <div role="radiogroup" aria-label={pick(locale, WORKSPACE_TRIGGER.heading)} style={{ margin: "0 0 12px" }}>
          {(Object.keys(TRIGGER_MODE_LABELS) as AnalysisTriggerMode[]).map((mode) => (
            <label key={mode} style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", cursor: pending ? "wait" : "pointer" }}>
              <input
                type="radio"
                name="workspace-default-trigger"
                value={mode}
                checked={draft.trigger === mode}
                disabled={pending}
                onChange={() => setDraft((current) => ({ ...current, trigger: mode }))}
              />
              <span style={{ fontSize: 14 }}>{pick(locale, TRIGGER_MODE_LABELS[mode])}</span>
            </label>
          ))}
        </div>
        <p className="overview-note" style={{ margin: "0 0 12px" }}>{pick(locale, TRIGGER_MODE_HINTS[draft.trigger])}</p>
        {draft.trigger === "push_count" ? (
          <label className="field">
            <span>{pick(locale, TRIGGER_MODES.countLabel)}</span>
            <select aria-label={pick(locale, WORKSPACE_TRIGGER.countAria)} value={draft.n} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, n: Number(event.target.value) }))}>
              {[3, 5, 10].map((value) => <option key={value} value={value}>{value}{pick(locale, TRIGGER_MODES.pushCountUnit)}</option>)}
            </select>
          </label>
        ) : null}
        {draft.trigger !== "push" ? (
          <label className="field">
            <span>{pick(locale, TRIGGER_MODES.hourLabel)}</span>
            <select aria-label={pick(locale, WORKSPACE_TRIGGER.hourAria)} value={draft.hour} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, hour: Number(event.target.value) }))}>
              {[0, 1, 2, 3, 4, 5, 6, 22, 23].map((value) => <option key={value} value={value}>{String(value).padStart(2, "0")}:00</option>)}
            </select>
          </label>
        ) : null}
        <button className="secondary-button" type="button" onClick={save} disabled={pending}>{pending ? pick(locale, SETTINGS_COMMON.saving) : pick(locale, SETTINGS_COMMON.save)}</button>
      </div>
      {error ? <p className="overview-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
