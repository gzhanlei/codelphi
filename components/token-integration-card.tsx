"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { CONNECTION_STATUS, TOKEN_CARD } from "@/lib/ui-strings/workspace";
import { errorMessage } from "../lib/error-message";
import { saveRepositoryConnection } from "../lib/integration-client";
import type { RepositoryConnectionState } from "../lib/repository-connections";
import type { RepositoryProvider } from "../lib/repository-providers";
import { connectionStatusLabel } from "../lib/integration-ui";
import { ConnectionActions } from "./connection-actions";
import { FormError } from "./form-feedback";

interface TokenIntegrationCardProps {
  kind: "gitee" | "self-hosted";
  connections: RepositoryConnectionState[];
  canEdit: boolean;
  allowlistConfigured?: boolean;
  locale?: UiLocale;
}

const providerNames: Record<RepositoryProvider, string> = { gitee: "Gitee", gitlab: "GitLab", gitea: "Gitea" };

function ConnectionGuide({ kind, allowlistConfigured, locale }: { kind: TokenIntegrationCardProps["kind"]; allowlistConfigured?: boolean; locale: UiLocale }) {
  const L = TOKEN_CARD;
  if (kind === "gitee") {
    return (
      <div className="connection-guide">
        <ol><li>{pick(locale, L.giteeStep1)}</li><li>{pick(locale, L.giteeStep2)}</li></ol>
        <a href="https://gitee.com/profile/personal_access_tokens" target="_blank" rel="noreferrer">{pick(locale, L.giteeTokenLink)}</a>
      </div>
    );
  }
  return (
    <div className="connection-guide">
      <ol><li>{pick(locale, L.selfHostedStep1)}</li><li>{pick(locale, L.selfHostedStep2Prefix)}<code>read_api</code>{pick(locale, L.selfHostedStep2Middle)}<code>read:user</code>{pick(locale, L.selfHostedStep2Suffix)}</li></ol>
      <span>{pick(locale, L.selfHostedApiNote)}</span>
      <span className="allowlist-note">{allowlistConfigured ? pick(locale, L.allowlistConfigured) : pick(locale, L.allowlistMissing)}</span>
    </div>
  );
}

function SavedConnections({ connections, canEdit, locale }: { connections: RepositoryConnectionState[]; canEdit: boolean; locale: UiLocale }) {
  if (connections.length === 0) return <div className="empty-state compact"><p>{pick(locale, TOKEN_CARD.savedEmpty)}</p></div>;
  return (
    <div className="connection-list">
      {connections.map((connection) => (
        <article className="connection-row" key={connection.id}>
          <div className="connection-meta">
            <strong>{connection.displayName}</strong>
            <span>{providerNames[connection.provider]} · @{connection.accountLogin} · {connection.tokenHint}</span>
            <span>{connection.baseUrl}</span>
            {connection.lastError && <span className="connection-error">{connection.lastError}</span>}
          </div>
          <span className={`connection-status ${connection.status}`}>{pick(locale, connection.status === "active" ? CONNECTION_STATUS.connected : CONNECTION_STATUS.disconnected)}</span>
          {canEdit && <ConnectionActions id={connection.id} status={connection.status} kind="repository" />}
        </article>
      ))}
    </div>
  );
}

function IntegrationHeading({ kind, locale }: { kind: TokenIntegrationCardProps["kind"]; locale: UiLocale }) {
  const isGitee = kind === "gitee";
  return <div className="integration-card-heading"><div className="integration-icon" aria-hidden="true">{isGitee ? "G" : "⌂"}</div><div><h2>{isGitee ? "Gitee" : pick(locale, TOKEN_CARD.selfHostedHeading)}</h2><p>{isGitee ? pick(locale, TOKEN_CARD.giteeSubtitle) : pick(locale, TOKEN_CARD.selfHostedSubtitle)}</p></div></div>;
}

function ProviderFields({ kind, provider, baseUrl, locale, onProviderChange, onBaseUrlChange }: { kind: TokenIntegrationCardProps["kind"]; provider: RepositoryProvider; baseUrl: string; locale: UiLocale; onProviderChange: (provider: RepositoryProvider) => void; onBaseUrlChange: (value: string) => void }) {
  const L = TOKEN_CARD;
  if (kind === "gitee") return null;
  return <>
    <label className="field"><span>{pick(locale, L.providerLabel)}<b>*</b></span><select value={provider} onChange={(event) => onProviderChange(event.target.value as RepositoryProvider)}><option value="gitlab">{pick(locale, L.gitlabOption)}</option><option value="gitea">Gitea</option></select></label>
    <label className="field"><span>{pick(locale, L.baseUrlLabel)}<b>*</b></span><input type="url" value={baseUrl} onChange={(event) => onBaseUrlChange(event.target.value)} placeholder="https://git.example.com" required /><small>{pick(locale, L.baseUrlHint)}</small></label>
  </>;
}

function TokenField({ kind, provider, token, locale, onTokenChange }: { kind: TokenIntegrationCardProps["kind"]; provider: RepositoryProvider; token: string; locale: UiLocale; onTokenChange: (value: string) => void }) {
  const L = TOKEN_CARD;
  return <label className="field"><span>{pick(locale, L.tokenLabel)}<b>*</b></span><input type="password" value={token} onChange={(event) => onTokenChange(event.target.value)} placeholder={kind === "gitee" ? pick(locale, L.giteeTokenPlaceholder) : `${pick(locale, L.providerTokenPlaceholderPrefix)}${providerNames[provider]}${pick(locale, L.providerTokenPlaceholderSuffix)}`} autoComplete="off" spellCheck={false} required /><small>{pick(locale, L.tokenHint)}</small></label>;
}

function ConnectionFormStatus({ pending, error, success, locale }: { pending: boolean; error: string; success: string; locale: UiLocale }) {
  return <><FormError message={error} />{success && <p className="form-success" role="status">{success}</p>}<button className="primary-button" type="submit" disabled={pending}>{pending ? pick(locale, TOKEN_CARD.verifying) : pick(locale, TOKEN_CARD.saveConnectionButton)}</button></>;
}

export function TokenIntegrationCard({ kind, connections, canEdit, allowlistConfigured = false, locale = "zh-CN" }: TokenIntegrationCardProps) {
  const router = useRouter();
  const [provider, setProvider] = useState<RepositoryProvider>(kind === "gitee" ? "gitee" : "gitlab");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const isGitee = kind === "gitee";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSuccess("");
    try {
      const result = await saveRepositoryConnection({ provider, baseUrl: isGitee ? undefined : baseUrl, token });
      setToken("");
      setSuccess(`${pick(locale, TOKEN_CARD.connectedPrefix)}${providerNames[provider]}${pick(locale, TOKEN_CARD.connectedMiddle)}${result.accountLogin}${pick(locale, TOKEN_CARD.connectedSuffix)}`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, "连接保存失败"));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="integration-card token-integration-card">
      <IntegrationHeading kind={kind} locale={locale} />
      <p className="connection-capability">{pick(locale, TOKEN_CARD.capability)}</p>
      <ConnectionGuide kind={kind} allowlistConfigured={allowlistConfigured} locale={locale} />
      {canEdit ? (
        <form onSubmit={submit}>
          <ProviderFields kind={kind} provider={provider} baseUrl={baseUrl} locale={locale} onProviderChange={(nextProvider) => { setProvider(nextProvider); setToken(""); setSuccess(""); }} onBaseUrlChange={setBaseUrl} />
          <TokenField kind={kind} provider={provider} token={token} locale={locale} onTokenChange={setToken} />
          <ConnectionFormStatus pending={pending} error={error} success={success} locale={locale} />
        </form>
      ) : <p className="permission-note">{pick(locale, TOKEN_CARD.viewerNote)}</p>}
      <SavedConnections connections={connections} canEdit={canEdit} locale={locale} />
    </section>
  );
}
