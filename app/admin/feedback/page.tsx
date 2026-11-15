import { AppShell } from "@/components/app-shell";
import { FeedbackIssueButton } from "@/components/feedback-issue-button";
import { listFeedbackReports } from "@/lib/feedback";
import { currentOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { requireSessionUser } from "@/lib/session";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { ADMIN_FEEDBACK as L } from "@/lib/ui-strings/admin";

export const dynamic = "force-dynamic";

export default async function FeedbackAdminPage() {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  await requirePlatformAdmin(user, organization);
  const reports = await listFeedbackReports();
  const locale = await resolveUiLocale();

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading"><div><span className="eyebrow">FEEDBACK ADMIN</span><h1>{pick(locale, L.heading)}</h1><p>{pick(locale, L.subheading)}</p></div></div>
      <div className="panel">
        {reports.length === 0 ? <p className="overview-note">{pick(locale, L.empty)}</p> : <table className="scenario-table">
          <thead><tr><th>{pick(locale, L.tableProduct)}</th><th>{pick(locale, L.tableWorkspace)}</th><th>{pick(locale, L.tableSource)}</th><th>{pick(locale, L.tableRevision)}</th><th>{pick(locale, L.tableError)}</th><th>{pick(locale, L.tableStatus)}</th><th>{pick(locale, L.tableActions)}</th></tr></thead>
          <tbody>{reports.map((report) => <tr key={report.id}>
            <td><strong>{report.productName}</strong><br /><small>{report.repositoryFullName}</small></td>
            <td>{report.organizationName}</td>
            <td>{report.reporterName ?? pick(locale, L.systemSource)}</td>
            <td><code>{report.revision.slice(0, 7)}</code></td>
            <td><span className="feedback-error">{report.errorMessage}</span>{report.architectureError ? <small className="feedback-error">{report.architectureError}</small> : null}</td>
            <td>{report.status === "submitted" ? pick(locale, L.statusSubmitted) : report.status === "failed" ? pick(locale, L.statusFailed) : pick(locale, L.statusPending)}</td>
            <td><FeedbackIssueButton id={report.id} issueUrl={report.githubIssueUrl} status={report.status} /></td>
          </tr>)}</tbody>
        </table>}
      </div>
    </AppShell>
  );
}
