"use client";

import Link from "next/link";
import { useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { mcpServersJson } from "@/lib/mcp/connect-configs";

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

/** MCP 集成面板（设置页）：组织级只读 key 的签发与撤销；明文仅创建时出现一次。
 *  连接向导：通用 mcpServers JSON 模板，签发后自动烤入真实 key（HP-3 展示端点与连接配置）。 */
export function McpKeysSettings({ initialKeys, canManage }: { initialKeys: McpKeyView[]; canManage: boolean }) {
  const [keys, setKeys] = useState(initialKeys);
  const [name, setName] = useState("");
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const endpoint = typeof window !== "undefined" ? `${window.location.origin}/api/mcp` : "/api/mcp";
  const configJson = mcpServersJson(endpoint, plaintext);

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
      setCopiedConfig(false);
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

  const copyConfig = async () => {
    await navigator.clipboard.writeText(configJson);
    setCopiedConfig(true);
  };

  return (
    <section className="overview-panel mcp-keys-panel">
      <div className="overview-panel-heading"><span>06</span><h2>MCP 集成</h2></div>
      <p>组织级只读 API key，供 Claude / ChatGPT 等 AI 客户端经 MCP 读取产品规格与行为变化（每条结论附证据链接）。撤销后立即失效。</p>
      <div className="mcp-guide">
        <span className="mcp-key-meta">MCP 端点（Streamable HTTP，Authorization: Bearer &lt;key&gt;）：<code>{endpoint}</code></span>
        <div className="mcp-guide-config">
          <div className="mcp-guide-config-head">
            <span>{plaintext ? "连接配置（已写入刚签发的 key，复制即用）" : "连接配置（签发 key 后自动写入真实值）"}</span>
            <button className="secondary-button" type="button" onClick={copyConfig}>{copiedConfig ? "已复制" : "复制配置"}</button>
          </div>
          <pre className="mcp-guide-code"><code>{configJson}</code></pre>
        </div>
        <ul className="mcp-guide-notes">
          <li>Claude Code：存为项目根目录 <code>.mcp.json</code>，或执行 <code>claude mcp add --transport http codelphi {endpoint} --header "Authorization: Bearer &lt;key&gt;"</code></li>
          <li>ZCode：<code>~/.zcode/cli/config.json</code> 的 <code>mcp.servers</code>（服务器对象同形状；团队共享可放仓库 <code>.zcode/config.json</code>）</li>
          <li>Cursor：<code>~/.cursor/mcp.json</code>（同样的 mcpServers 形状）</li>
          <li>ChatGPT / Claude 网页版连接器：选择 OAuth 连接，会自动发现本站授权页；详见 <Link href="/mcp">MCP 连接指南</Link></li>
          <li>接入验证：在 agent 里问「列出我的 CoDelphi 产品」，应触发 list_projects 返回本工作区产品</li>
        </ul>
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
