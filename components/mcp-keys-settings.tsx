"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/error-message";

interface McpKeyView {
  id: number;
  name: string;
  keyHint: string;
  createdBy: string;
  createdAt: string | Date | null;
  revokedAt: string | Date | null;
}

function formatDate(value: string | Date | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

/** MCP 集成面板（设置页）：组织级只读 key 的签发与撤销；明文仅创建时出现一次。 */
export function McpKeysSettings({ initialKeys, canManage }: { initialKeys: McpKeyView[]; canManage: boolean }) {
  const [keys, setKeys] = useState(initialKeys);
  const [name, setName] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = async () => {
    const response = await fetch("/api/mcp-keys", { cache: "no-store" });
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? "加载 key 列表失败");
    const data = await response.json() as { keys?: McpKeyView[] };
    setKeys(data.keys ?? []);
  };

  const create = async () => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/mcp-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json() as { plaintext?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "签发失败");
      setPlaintext(data.plaintext ?? null);
      setCopied(false);
      setNotice("key 已签发，明文只显示这一次，请立即保存");
      setName("");
      await load();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "签发失败"));
    } finally {
      setPending(false);
    }
  };

  const revoke = async (id: number) => {
    setPending(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/mcp-keys/${id}`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "撤销失败");
      setNotice("key 已撤销，使用该 key 的连接将立即失效");
      await load();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "撤销失败"));
    } finally {
      setPending(false);
    }
  };

  const copyPlaintext = async () => {
    if (!plaintext) return;
    await navigator.clipboard.writeText(plaintext);
    setCopied(true);
  };

  return (
    <section className="overview-panel mcp-keys-panel">
      <div className="overview-panel-heading"><span>06</span><h2>MCP 集成</h2></div>
      <p>组织级只读 API key，供 Claude / ChatGPT 等 AI 客户端经 MCP 读取产品规格与行为变化（每条结论附证据链接）。撤销后立即失效。</p>
      <div className="mcp-keys-endpoint">
        <span className="mcp-key-meta">MCP 端点（Streamable HTTP，Authorization: Bearer &lt;key&gt;）：<code>{typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp"}</code></span>
        <span className="mcp-key-meta">Claude Code 连接示例：<code>claude mcp add --transport http codelphi &lt;端点&gt; --header "Authorization: Bearer &lt;key&gt;"</code></span>
      </div>
      {canManage ? (
        <div className="mcp-keys-create">
          <input
            value={name}
            maxLength={191}
            placeholder="key 名称（如：ChatGPT / Claude）"
            aria-label="key 名称"
            onChange={(event) => setName(event.target.value)}
          />
          <button className="secondary-button" type="button" disabled={pending || !name.trim()} onClick={create}>签发 key</button>
        </div>
      ) : null}
      {plaintext ? (
        <div className="mcp-keys-plaintext">
          <code>{plaintext}</code>
          <button className="secondary-button" type="button" onClick={copyPlaintext}>{copied ? "已复制" : "复制"}</button>
        </div>
      ) : null}
      <div className="mcp-keys-list">
        {keys.length === 0 ? <p className="overview-note">尚无 key。</p> : keys.map((key) => (
          <div className="mcp-key-row" key={key.id}>
            <div>
              <strong>{key.name}</strong>
              <code className="mcp-key-hint">sk_cd_…{key.keyHint}</code>
              <span className="mcp-key-meta">由 {key.createdBy} 创建于 {formatDate(key.createdAt)}</span>
            </div>
            {key.revokedAt ? (
              <span className="mcp-key-status revoked">已撤销 {formatDate(key.revokedAt)}</span>
            ) : (
              <span className="mcp-key-status active">生效中{canManage ? <button className="mcp-key-revoke" type="button" disabled={pending} onClick={() => revoke(key.id)}>撤销</button> : null}</span>
            )}
          </div>
        ))}
      </div>
      {notice ? <p className="description-dialog-error release-notes-notice" role="status">{notice}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </section>
  );
}
