"use client";

import { useState } from "react";

/** 可复制文本块（/mcp 公开页用）：标题行 + 复制按钮 + pre/code，复用 mcp-guide 样式。 */
export function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
  };
  return (
    <div className="mcp-guide-config">
      <div className="mcp-guide-config-head">
        <span>{label}</span>
        <button className="secondary-button" type="button" onClick={copy}>{copied ? "已复制" : "复制"}</button>
      </div>
      <pre className="mcp-guide-code"><code>{text}</code></pre>
    </div>
  );
}
