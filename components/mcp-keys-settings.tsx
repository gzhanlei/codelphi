"use client";

import Link from "next/link";
import { useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { mcpServersJson } from "@/lib/mcp/connect-configs";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { MCP_KEYS, SETTINGS_COMMON } from "@/lib/ui-strings/workspace";
import { formatDateTimeIn } from "@/lib/format";

interface McpKeyView {
  id: number;
  name: string;
  keyHint: string;
  createdBy: string;
  createdAt: string | Date | null;
  revokedAt: string | Date | null;
}

/** MCP 集成面板（设置页）：组织级只读 key 的签发与撤销；明文仅创建时出现一次。
 *  连接向导：通用 mcpServers JSON 模板，签发后自动烤入真实 key（HP-3 展示端点与连接配置）。 */
export function McpKeysSettings({ initialKeys, canManage, locale = "zh-CN" }: { initialKeys: McpKeyView[]; canManage: boolean; locale?: UiLocale }) {
  const L = MCP_KEYS;
  const formatDate = (value: string | Date | null) => formatDateTimeIn(locale, value);
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
      setNotice(pick(locale, L.issuedNotice));
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
      setNotice(pick(locale, L.revokedNotice));
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
      <div className="overview-panel-heading"><span>06</span><h2>{pick(locale, L.heading)}</h2></div>
      <p>{pick(locale, L.intro)}</p>
      <div className="mcp-guide">
        <span className="mcp-key-meta">{pick(locale, L.endpointLabel)}<code>{endpoint}</code></span>
        <div className="mcp-guide-config">
          <div className="mcp-guide-config-head">
            <span>{plaintext ? pick(locale, L.configFresh) : pick(locale, L.configPlaceholder)}</span>
            <button className="secondary-button" type="button" onClick={copyConfig}>{copiedConfig ? pick(locale, SETTINGS_COMMON.copied) : pick(locale, SETTINGS_COMMON.copyConfig)}</button>
          </div>
          <pre className="mcp-guide-code"><code>{configJson}</code></pre>
        </div>
        <ul className="mcp-guide-notes">
          <li>{pick(locale, L.claudeGuidePrefix)}<code>.mcp.json</code>{pick(locale, L.claudeGuideMiddle)}<code>claude mcp add --transport http codelphi {endpoint} --header "Authorization: Bearer &lt;key&gt;"</code></li>
          <li>{pick(locale, L.zcodeGuidePrefix)}<code>~/.zcode/cli/config.json</code>{pick(locale, L.zcodeGuideMiddle)}<code>mcp.servers</code>{pick(locale, L.zcodeGuideMiddle2)}<code>.zcode/config.json</code>{pick(locale, L.zcodeGuideSuffix)}</li>
          <li>{pick(locale, L.cursorGuidePrefix)}<code>~/.cursor/mcp.json</code>{pick(locale, L.cursorGuideSuffix)}</li>
          <li>{pick(locale, L.connectorGuidePrefix)}<Link href="/mcp">{pick(locale, L.guideLink)}</Link></li>
          <li>{pick(locale, L.verifyGuide)}</li>
        </ul>
      </div>
      {canManage ? (
        <div className="mcp-keys-create">
          <input
            value={name}
            maxLength={191}
            placeholder={pick(locale, L.namePlaceholder)}
            aria-label={pick(locale, L.nameAria)}
            onChange={(event) => setName(event.target.value)}
          />
          <button className="secondary-button" type="button" disabled={pending || !name.trim()} onClick={create}>{pick(locale, L.issueButton)}</button>
        </div>
      ) : null}
      {plaintext ? (
        <div className="mcp-keys-plaintext">
          <code>{plaintext}</code>
          <button className="secondary-button" type="button" onClick={copyPlaintext}>{copied ? pick(locale, SETTINGS_COMMON.copied) : pick(locale, SETTINGS_COMMON.copy)}</button>
        </div>
      ) : null}
      <div className="mcp-keys-list">
        {keys.length === 0 ? <p className="overview-note">{pick(locale, L.noKeys)}</p> : keys.map((key) => (
          <div className="mcp-key-row" key={key.id}>
            <div>
              <strong>{key.name}</strong>
              <code className="mcp-key-hint">sk_cd_…{key.keyHint}</code>
              <span className="mcp-key-meta">{pick(locale, L.createdByPrefix)}{key.createdBy}{pick(locale, L.createdByMiddle)}{formatDate(key.createdAt)}</span>
            </div>
            {key.revokedAt ? (
              <span className="mcp-key-status revoked">{pick(locale, L.revokedPrefix)}{formatDate(key.revokedAt)}</span>
            ) : (
              <span className="mcp-key-status active">{pick(locale, L.activeStatus)}{canManage ? <button className="mcp-key-revoke" type="button" disabled={pending} onClick={() => revoke(key.id)}>{pick(locale, L.revokeButton)}</button> : null}</span>
            )}
          </div>
        ))}
      </div>
      {notice ? <p className="description-dialog-error release-notes-notice" role="status">{notice}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </section>
  );
}
