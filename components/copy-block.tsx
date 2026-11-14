"use client";

import { useState } from "react";

import { pick, type UiLocale } from "@/lib/ui-locale";

/** 可复制文本块（/mcp 公开页用）：标题行 + 复制按钮 + pre/code，复用 mcp-guide 样式。 */
export function CopyBlock({ label, text, locale = "zh-CN" }: { label: string; text: string; locale?: UiLocale }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };
  return (
    <div className="mcp-guide-config">
      <div className="mcp-guide-config-head">
        <span>{label}</span>
        <button className="secondary-button" type="button" onClick={copy}>{copied ? pick(locale, { "zh-CN": "已复制", en: "Copied" }) : pick(locale, { "zh-CN": "复制", en: "Copy" })}</button>
      </div>
      <pre className="mcp-guide-code"><code>{text}</code></pre>
    </div>
  );
}
