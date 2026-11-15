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
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { pick, type LocaleEntry } from "@/lib/ui-locale";
import { INTEGRATIONS_PAGE } from "@/lib/ui-strings/workspace";

export const dynamic = "force-dynamic";

const messages: Record<string, LocaleEntry> = {
  manifest_state: INTEGRATIONS_PAGE.messageManifestState,
  conversion_failed: INTEGRATIONS_PAGE.messageConversionFailed,
  app_missing: INTEGRATIONS_PAGE.messageAppMissing,
  installation_id: INTEGRATIONS_PAGE.messageInstallationId,
  installation_failed: INTEGRATIONS_PAGE.messageInstallationFailed,
  installation_state: INTEGRATIONS_PAGE.messageInstallationState,
  connected: INTEGRATIONS_PAGE.messageConnected,
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const { error, success } = await searchParams;
  const locale = await resolveUiLocale();
  const L = INTEGRATIONS_PAGE;
  const [app, connections, repositoryConnections] = await Promise.all([
    getLatestGitHubApp(),
    listConnectionStates(organization.id),
    listRepositoryConnections(organization.id),
  ]);
  const hasPat = Boolean(process.env.GITHUB_TOKEN?.trim());
  const canEdit = organization.role !== "viewer";
  const localizedMessages = Object.fromEntries(Object.entries(messages).map(([key, entry]) => [key, pick(locale, entry)]));
  const feedback = integrationFeedback(error, success, localizedMessages);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">REPOSITORY CONNECTIONS</span><h1>{pick(locale, L.heading)}</h1><p>{pick(locale, L.headingBody)}</p></div>
      </div>
      <IntegrationMessage message={feedback.text} isError={feedback.isError} />
      <GitHubAppCard app={app} connections={connections} canEdit={canEdit} locale={locale} />
      <div className="repository-provider-grid">
        <TokenIntegrationCard kind="gitee" connections={repositoryConnections.filter((connection) => connection.provider === "gitee")} canEdit={canEdit} locale={locale} />
        <TokenIntegrationCard kind="self-hosted" connections={repositoryConnections.filter((connection) => connection.provider !== "gitee")} canEdit={canEdit} allowlistConfigured={Boolean(process.env.REPOSITORY_HOST_ALLOWLIST?.trim())} locale={locale} />
      </div>
      {hasPat && <PatFallbackCard configured locale={locale} />}
    </AppShell>
  );
}
