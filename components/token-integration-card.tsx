"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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
}

const providerNames: Record<RepositoryProvider, string> = { gitee: "Gitee", gitlab: "GitLab", gitea: "Gitea" };

function ConnectionGuide({ kind, allowlistConfigured }: { kind: TokenIntegrationCardProps["kind"]; allowlistConfigured?: boolean }) {
  if (kind === "gitee") {
    return (
      <div className="connection-guide">
        <ol><li>在 Gitee 创建私人令牌，只勾选读取用户信息和仓库所需的最小权限。</li><li>粘贴令牌，Radar 会验证账号后再加密保存。</li></ol>
        <a href="https://gitee.com/profile/personal_access_tokens" target="_blank" rel="noreferrer">打开 Gitee 令牌设置 ↗</a>
      </div>
    );
  }
  return (
    <div className="connection-guide">
      <ol><li>确保 Radar 服务器能访问你的 Git 服务，并启用有效的 HTTPS 证书。</li><li>创建访问令牌：GitLab 使用 <code>read_api</code>，Gitea 使用 <code>read:user</code>，再按仓库读取需要授权。</li></ol>
      <span>当前支持 GitLab 与 Gitea API；暂不支持 SSH 地址。</span>
      <span className="allowlist-note">{allowlistConfigured ? "仅允许 REPOSITORY_HOST_ALLOWLIST 中登记的主机和端口；GitLab.com 默认可用。" : "自有服务尚未配置主机白名单，请联系管理员设置 REPOSITORY_HOST_ALLOWLIST；GitLab.com 可直接连接。"}</span>
    </div>
  );
}

function SavedConnections({ connections, canEdit }: { connections: RepositoryConnectionState[]; canEdit: boolean }) {
  if (connections.length === 0) return <div className="empty-state compact"><p>还没有已保存的连接。</p></div>;
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
          <span className={`connection-status ${connection.status}`}>{connectionStatusLabel(connection.status)}</span>
          {canEdit && <ConnectionActions id={connection.id} status={connection.status} kind="repository" />}
        </article>
      ))}
    </div>
  );
}

export function TokenIntegrationCard({ kind, connections, canEdit, allowlistConfigured = false }: TokenIntegrationCardProps) {
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
      setSuccess(`已连接 ${providerNames[provider]} 账号 @${result.accountLogin}。`);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, "连接保存失败"));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="integration-card token-integration-card">
      <div className="integration-card-heading">
        <div className="integration-icon" aria-hidden="true">{isGitee ? "G" : "⌂"}</div>
        <div><h2>{isGitee ? "Gitee" : "自有 Git 服务"}</h2><p>{isGitee ? "使用私人令牌连接 Gitee 账号" : "连接 GitLab、Gitea 或内网部署的 Git 服务"}</p></div>
      </div>
      <p className="connection-capability">当前开放连接配置与验证；添加产品和架构分析仍仅支持 GitHub。</p>
      <ConnectionGuide kind={kind} allowlistConfigured={allowlistConfigured} />
      {canEdit ? (
        <form onSubmit={submit}>
          {!isGitee && (
            <label className="field"><span>平台类型 <b>*</b></span><select value={provider} onChange={(event) => { setProvider(event.target.value as RepositoryProvider); setToken(""); setSuccess(""); }}><option value="gitlab">GitLab（云端或自托管）</option><option value="gitea">Gitea</option></select></label>
          )}
          {!isGitee && (
            <label className="field"><span>服务地址 <b>*</b></span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://git.example.com" required /><small>填写服务根地址，不要包含 /api/v4、/api/v1 或仓库路径。</small></label>
          )}
          <label className="field"><span>访问令牌 <b>*</b></span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={isGitee ? "粘贴 Gitee 私人令牌" : `粘贴 ${providerNames[provider]} 访问令牌`} autoComplete="off" spellCheck={false} required /><small>仅用于服务端连接验证，保存后不会再次显示；删除连接会清除令牌。</small></label>
          <FormError message={error} />
          {success && <p className="form-success" role="status">{success}</p>}
          <button className="primary-button" type="submit" disabled={pending}>{pending ? "正在验证连接…" : "验证并保存连接"}</button>
        </form>
      ) : <p className="permission-note">工作区查看者只能查看连接状态，请联系编辑者或所有者配置。</p>}
      <SavedConnections connections={connections} canEdit={canEdit} />
    </section>
  );
}
