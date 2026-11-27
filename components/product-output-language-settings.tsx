"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { OUTPUT_LANGUAGE_HINTS, OUTPUT_LANGUAGE_LABELS, type OutputLanguage } from "@/lib/analysis-language";
import { setOutputLanguage } from "@/lib/product-client";

const LANGUAGES: OutputLanguage[] = ["zh-CN", "en"];

/** 产品设置页 · 分析输出语言：切换后下一次分析强制全量重建，历史版本保持原语言。 */
export function ProductOutputLanguageSettings({ slug, current, canEdit }: { slug: string; current: OutputLanguage; canEdit: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState<OutputLanguage>(current);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  if (!canEdit) return null;

  const save = async () => {
    if (draft === current) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      await setOutputLanguage(slug, draft);
      setNotice("输出语言已保存：下一次分析将全量重建为新语言版本，历史版本保持原语言");
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存输出语言设置失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>07</span><h2>分析输出语言</h2></div>
      <p className="overview-note">AI 提取的功能规格、场景与发布稿按所选语言生成。切换语言后，下一次分析将全量重建为新语言版本；历史版本按各自语言只读保留。</p>
      <div className="settings-form">
        <div role="radiogroup" aria-label="分析输出语言" style={{ margin: "0 0 12px" }}>
          {LANGUAGES.map((language) => (
            <label key={language} style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", cursor: pending ? "wait" : "pointer" }}>
              <input
                type="radio"
                name="product-output-language"
                value={language}
                checked={draft === language}
                disabled={pending}
                onChange={() => setDraft(language)}
              />
              <span style={{ fontSize: 14 }}>{OUTPUT_LANGUAGE_LABELS[language]}</span>
            </label>
          ))}
        </div>
        <p className="overview-note" style={{ margin: "0 0 12px" }}>{OUTPUT_LANGUAGE_HINTS[draft]}</p>
        <button className="secondary-button" type="button" onClick={save} disabled={pending || draft === current}>{pending ? "保存中…" : "保存"}</button>
      </div>
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
      {notice && !error ? <p className="form-success" role="status">{notice}</p> : null}
    </section>
  );
}
