"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { OUTPUT_LANGUAGE_LABELS, type OutputLanguage } from "@/lib/analysis-language";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { OUTPUT_LANGUAGE_PANEL_HINTS, SETTINGS_COMMON, WORKSPACE_OUTPUT_LANGUAGE } from "@/lib/ui-strings/workspace";

const LANGUAGES: OutputLanguage[] = ["zh-CN", "en"];

/** 设置页 · 工作区默认输出语言：新接入的产品注册时继承此设置，已有产品不受影响。 */
export function WorkspaceOutputLanguageSettings({ canEdit, current, locale = "zh-CN" }: { canEdit: boolean; current: OutputLanguage; locale?: UiLocale }) {
  const router = useRouter();
  const [draft, setDraft] = useState<OutputLanguage>(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!canEdit) return null;

  const save = async () => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/settings/output-language-default", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: draft }),
      });
      const data = await response.json() as { status?: string; error?: string };
      if (!response.ok || data.status !== "updated") throw new Error(data.error ?? "保存默认输出语言失败");
      setNotice(pick(locale, WORKSPACE_OUTPUT_LANGUAGE.savedNotice));
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存默认输出语言失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>02</span><h2>{pick(locale, WORKSPACE_OUTPUT_LANGUAGE.heading)}</h2></div>
      <p className="overview-note">{pick(locale, WORKSPACE_OUTPUT_LANGUAGE.note)}</p>
      <div className="settings-form">
        <div role="radiogroup" aria-label={pick(locale, WORKSPACE_OUTPUT_LANGUAGE.heading)} style={{ margin: "0 0 12px" }}>
          {LANGUAGES.map((language) => (
            <label key={language} style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", cursor: pending ? "wait" : "pointer" }}>
              <input
                type="radio"
                name="workspace-default-output-language"
                value={language}
                checked={draft === language}
                disabled={pending}
                onChange={() => setDraft(language)}
              />
              <span style={{ fontSize: 14 }}>{OUTPUT_LANGUAGE_LABELS[language]}</span>
            </label>
          ))}
        </div>
        <p className="overview-note" style={{ margin: "0 0 12px" }}>{pick(locale, OUTPUT_LANGUAGE_PANEL_HINTS[draft])}</p>
        <button className="secondary-button" type="button" onClick={save} disabled={pending}>{pending ? pick(locale, SETTINGS_COMMON.saving) : pick(locale, SETTINGS_COMMON.save)}</button>
      </div>
      {error ? <p className="overview-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
