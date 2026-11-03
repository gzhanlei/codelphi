import { AppShell } from "@/components/app-shell";
import { GitHubAppCard } from "@/components/github-app-card";
import { IntegrationMessage } from "@/components/integration-message";
import { PatFallbackCard } from "@/components/pat-fallback-card";
import { getLatestGitHubApp, listConnectionStates } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";
import { integrationFeedback } from "@/lib/integration-ui";
import { requireOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  manifest_state: "GitHub App 创建状态已失效，请重新发起。",
  conversion_failed: "无法转换 GitHub App 凭据，请重试。",
  app_missing: "尚未创建 GitHub App。",
  installation_id: "GitHub 返回的 Installation ID 无效。",
  installation_failed: "无法验证 GitHub 安装，请检查应用权限后重试。",
  connected: "GitHub 已连接，现在可以添加产品。",
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const { error, success } = await searchParams;
  const [app, connections] = await Promise.all([getLatestGitHubApp(), listConnectionStates(organization.id)]);
  const hasPat = Boolean(process.env.GITHUB_TOKEN?.trim());
  const feedback = integrationFeedback(error, success, messages);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">INTEGRATIONS</span><h1>连接与集成</h1><p>用只读权限连接代码仓库，不让凭据进入浏览器或产品数据库明文。</p></div>
      </div>
      <IntegrationMessage message={feedback.text} isError={feedback.isError} />
      <GitHubAppCard app={app} connections={connections} />
      <PatFallbackCard configured={hasPat} />
    </AppShell>
  );
}
