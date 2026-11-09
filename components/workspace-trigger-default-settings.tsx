"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import type { AnalysisTriggerMode } from "@/lib/analysis-trigger";

const MODE_LABELS: Record<AnalysisTriggerMode, string> = {
  push: "每次 push（实时）",
  daily: "每天低峰期一次",
  push_count: "每 N 次 push + 当天兜底",
};

/** 设置页 · 工作区默认触发模式：新接入的仓库继承此设置，已有仓库不受影响。 */
export function WorkspaceTriggerDefaultSettings({ canEdit, current }: { canEdit: boolean; current: { trigger: AnalysisTriggerMode; n: number | null; hour: number | null } }) {
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
      setNotice("默认触发设置已保存：此后新接入的仓库将继承此模式");
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存默认触发设置失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>02</span><h2>新仓库默认触发模式</h2></div>
      <p className="overview-note">此后新接入的仓库将继承此设置；已有仓库在各产品的「设置 → 分析触发模式」里单独管理，不受影响。</p>
      <div className="settings-form">
        <label className="field">
          <span>默认触发模式</span>
          <select aria-label="新仓库默认触发模式" value={draft.trigger} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, trigger: event.target.value as AnalysisTriggerMode }))}>
            {(Object.keys(MODE_LABELS) as AnalysisTriggerMode[]).map((mode) => (
              <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>
            ))}
          </select>
        </label>
        {draft.trigger === "push_count" ? (
          <label className="field">
            <span>每 N 次推送</span>
            <select aria-label="新仓库推送次数阈值" value={draft.n} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, n: Number(event.target.value) }))}>
              {[3, 5, 10].map((value) => <option key={value} value={value}>{value} 次</option>)}
            </select>
          </label>
        ) : null}
        {draft.trigger !== "push" ? (
          <label className="field">
            <span>低峰分析时间（服务器时区）</span>
            <select aria-label="新仓库低峰分析时间" value={draft.hour} disabled={pending} onChange={(event) => setDraft((current) => ({ ...current, hour: Number(event.target.value) }))}>
              {[0, 1, 2, 3, 4, 5, 6, 22, 23].map((value) => <option key={value} value={value}>{String(value).padStart(2, "0")}:00</option>)}
            </select>
          </label>
        ) : null}
        <button className="secondary-button" type="button" onClick={save} disabled={pending}>{pending ? "保存中…" : "保存"}</button>
      </div>
      {error ? <p className="overview-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
