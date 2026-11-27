"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import type { AnalysisExecutor } from "@/lib/analysis-executor";
import { setAnalysisExecutor } from "@/lib/product-client";
import { pick, type LocaleEntry, type UiLocale } from "@/lib/ui-locale";
import { ANALYSIS_EXECUTOR, SETTINGS_COMMON } from "@/lib/ui-strings/workspace";

const OPTIONS: Array<{ value: AnalysisExecutor; label: LocaleEntry; hint: LocaleEntry }> = [
  { value: "client", label: ANALYSIS_EXECUTOR.clientLabel, hint: ANALYSIS_EXECUTOR.clientHint },
  { value: "server", label: ANALYSIS_EXECUTOR.serverLabel, hint: ANALYSIS_EXECUTOR.serverHint },
];

/**
 * 产品设置 · 分析方式：客户端分析（在本机跑，源码不离开电脑）还是服务端分析（服务器读仓库，调用工作区自己的模型）。
 * 工作区没配自己的模型时不能选服务端分析：CoDelphi 不替用户付模型费用（lib/analysis-executor.ts 在服务端再查一遍）。
 */
export function ProductAnalysisExecutorSettings({
  slug,
  current,
  modelConfigured,
  canEdit,
  locale = "zh-CN",
}: {
  slug: string;
  current: AnalysisExecutor;
  /** 工作区有没有自己的模型配置。 */
  modelConfigured: boolean;
  canEdit: boolean;
  locale?: UiLocale;
}) {
  const L = ANALYSIS_EXECUTOR;
  const router = useRouter();
  const [draft, setDraft] = useState<AnalysisExecutor>(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!canEdit) return null;

  const needsModel = !modelConfigured;
  const hint = OPTIONS.find((option) => option.value === draft)?.hint ?? ANALYSIS_EXECUTOR.clientHint;

  const save = async () => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await setAnalysisExecutor(slug, draft);
      setNotice(pick(locale, L.savedNotice));
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存分析方式失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>06</span><h2>{pick(locale, L.heading)}</h2></div>
      <p className="overview-note">{pick(locale, L.note)}</p>
      <div className="settings-form">
        <div role="radiogroup" aria-label={pick(locale, L.heading)} style={{ margin: "0 0 12px" }}>
          {OPTIONS.map((option) => {
            // 当前就是服务端分析、但工作区没有模型（配置后来被删了）：这一项仍然选中，好让人看见问题在哪；
            // 现在是客户端分析的产品，没配模型就不能切过去。
            const locked = option.value === "server" && needsModel && draft !== "server";
            return (
              <label key={option.value} style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", cursor: locked ? "not-allowed" : pending ? "wait" : "pointer", opacity: locked ? 0.6 : 1 }}>
                <input
                  type="radio"
                  name="product-analysis-executor"
                  value={option.value}
                  checked={draft === option.value}
                  disabled={pending || locked}
                  onChange={() => setDraft(option.value)}
                />
                <span style={{ fontSize: 14 }}>{pick(locale, option.label)}</span>
              </label>
            );
          })}
        </div>
        <p className="overview-note" style={{ margin: "0 0 12px" }}>{pick(locale, hint)}</p>
        {needsModel ? (
          <p className="overview-note" role="alert" style={{ margin: "0 0 12px" }}>
            {pick(locale, L.needsModel)}
            <Link href="/settings" className="text-button">{pick(locale, L.settingsLink)}</Link>
          </p>
        ) : null}
        <button className="secondary-button" type="button" onClick={save} disabled={pending || draft === current || (draft === "server" && needsModel)}>{pending ? pick(locale, SETTINGS_COMMON.saving) : pick(locale, SETTINGS_COMMON.save)}</button>
      </div>
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
