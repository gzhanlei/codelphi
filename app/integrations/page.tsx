import { AppShell } from "@/components/app-shell";
import { GitHubAppCard } from "@/components/github-app-card";
import { IntegrationMessage } from "@/components/integration-message";
import { PatFallbackCard } from "@/components/pat-fallback-card";
import { TokenIntegrationCard } from "@/components/token-integration-card";
import { getLatestGitHubApp, listConnectionStates } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";
import { integrationFeedback } from "@/lib/integration-ui";
import { requireOrganization } from "@/lib/organizations";
import { listRepositoryConnections } from "@/lib/repository-connections";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  manifest_state: "GitHub App 创建状态已失效，请重新发起。",
  conversion_failed: "无法转换 GitHub App 凭据，请重试。",
  app_missing: "尚未创建 GitHub App。",
  installation_id: "GitHub 返回的 Installation ID 无效。",
  installation_failed: "无法验证 GitHub 安装，请检查应用权限后重试。",
  installation_state: "GitHub 安装状态已失效或与当前工作区不匹配，请重新发起连接。",
  connected: "GitHub 已连接，现在可以添加产品。",
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const { error, success } = await searchParams;
  const [app, connections, repositoryConnections] = await Promise.all([
    getLatestGitHubApp(),
    listConnectionStates(organization.id),
    listRepositoryConnections(organization.id),
  ]);
  const hasPat = Boolean(process.env.GITHUB_TOKEN?.trim());
  const canEdit = organization.role !== "viewer";
  const feedback = integrationFeedback(error, success, messages);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">REPOSITORY CONNECTIONS</span><h1>代码仓库连接</h1><p>连接 GitHub、Gitee 或自有 Git 服务。按最小权限授权，访问令牌仅保存在服务端加密存储中。</p></div>
      </div>
      <IntegrationMessage message={feedback.text} isError={feedback.isError} />
      <GitHubAppCard app={app} connections={connections} canEdit={canEdit} />
      <div className="repository-provider-grid">
        <TokenIntegrationCard kind="gitee" connections={repositoryConnections.filter((connection) => connection.provider === "gitee")} canEdit={canEdit} />
        <TokenIntegrationCard kind="self-hosted" connections={repositoryConnections.filter((connection) => connection.provider !== "gitee")} canEdit={canEdit} allowlistConfigured={Boolean(process.env.REPOSITORY_HOST_ALLOWLIST?.trim())} />
      </div>
      {hasPat && <PatFallbackCard configured />}
    </AppShell>
  );
}
