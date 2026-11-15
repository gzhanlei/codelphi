import { AppShell } from "@/components/app-shell";
import { FeedbackIssueButton } from "@/components/feedback-issue-button";
import { listFeedbackReports, type FeedbackReport } from "@/lib/feedback";
import { currentOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { requireSessionUser } from "@/lib/session";
import { pick } from "@/lib/ui-locale";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { ADMIN_FEEDBACK as L } from "@/lib/ui-strings/admin";

export const dynamic = "force-dynamic";

type AdminFeedbackStrings = typeof L;
const VERDICT_LABEL: Record<string, keyof AdminFeedbackStrings> = {
  confirmed_defect: "verdictConfirmed",
  false_alarm: "verdictFalseAlarm",
  needs_human: "verdictNeedsHuman",
};

function VerdictCell({ report, locale }: { report: FeedbackReport; locale: "zh-CN" | "en" }) {
  return (
    <td>
      {report.verdict
        ? <span className="badge">{pick(locale, L[VERDICT_LABEL[report.verdict] ?? "verdictPending"])}{report.correctiveRunId ? <> · {pick(locale, L.correctiveRunLabel)} #{report.correctiveRunId}</> : null}</span>
        : <span className="badge">{pick(locale, L.verdictPending)}</span>}
      {report.verdictReason ? <small style={{ display: "block", maxWidth: 320, whiteSpace: "normal" }}>{report.verdictReason}</small> : null}
    </td>
  );
}

function ReportRow({ report, locale }: { report: FeedbackReport; locale: "zh-CN" | "en" }) {
  return (
    <tr key={report.id}>
      <td><strong>{report.productName}</strong><br /><small>{report.repositoryFullName}</small></td>
      <td>{report.organizationName}</td>
      <td>{report.reporterName ?? pick(locale, L.systemSource)}</td>
      <td><code>{report.revision.slice(0, 7)}</code></td>
      <td><span className="feedback-error">{report.errorMessage}</span>{report.architectureError ? <small className="feedback-error">{report.architectureError}</small> : null}</td>
      <VerdictCell report={report} locale={locale} />
      <td>{report.status === "submitted" ? pick(locale, L.statusSubmitted) : report.status === "failed" ? pick(locale, L.statusFailed) : pick(locale, L.statusPending)}</td>
      <td><FeedbackIssueButton id={report.id} issueUrl={report.githubIssueUrl} status={report.status} /></td>
    </tr>
  );
}

const TableHead = ({ locale }: { locale: "zh-CN" | "en" }) => (
  <thead><tr><th>{pick(locale, L.tableProduct)}</th><th>{pick(locale, L.tableWorkspace)}</th><th>{pick(locale, L.tableSource)}</th><th>{pick(locale, L.tableRevision)}</th><th>{pick(locale, L.tableError)}</th><th>{pick(locale, L.verdictColumn)}</th><th>{pick(locale, L.tableStatus)}</th><th>{pick(locale, L.tableActions)}</th></tr></thead>
);

/** Feedback 异常台（2026-11-15 用户裁定 AI 裁决优先）：人不再逐条裁决——默认只看
 *  AI 搞不定的（needs_human）；AI 已处置记录折叠为审计面供抽查；分析失败诊断单列
 *  （analysis_run_id 非空 = 基础设施失败，与账本主张天然可区分）。 */
export default async function FeedbackAdminPage() {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  await requirePlatformAdmin(user, organization);
  const locale = await resolveUiLocale();
  const reports = await listFeedbackReports();

  // 分组：账本主张（analysis_run_id NULL）按裁决状态；run 失败（run_id 非空）单列诊断面
  const ledgerClaims = reports.filter((report) => report.analysisRunId === null);
  const needsHuman = ledgerClaims.filter((report) => report.verdict === "needs_human" || report.verdict === null);
  const autoHandled = ledgerClaims.filter((report) => report.verdict === "confirmed_defect" || report.verdict === "false_alarm");
  const runFailures = reports.filter((report) => report.analysisRunId !== null);
  const confirmedCount = autoHandled.filter((report) => report.verdict === "confirmed_defect").length;

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading"><div><span className="eyebrow">FEEDBACK ADMIN</span><h1>{pick(locale, L.heading)}</h1><p>{pick(locale, L.subheading)}</p></div></div>
      <p className="overview-note" role="status">{pick(locale, L.boardStats).replace("{needsHuman}", String(needsHuman.length)).replace("{handled}", String(autoHandled.length)).replace("{confirmed}", String(confirmedCount)).replace("{failures}", String(runFailures.length))}</p>

      <div className="panel">
        <h2>{pick(locale, L.sectionNeedsHuman)}（{needsHuman.length}）</h2>
        <p className="overview-note">{pick(locale, L.needsHumanNote)}</p>
        {needsHuman.length === 0 ? <p className="overview-note">{pick(locale, L.emptyNeedsHuman)}</p> : (
          <table className="scenario-table">
            <TableHead locale={locale} />
            <tbody>{needsHuman.map((report) => <ReportRow report={report} locale={locale} key={report.id} />)}</tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <details>
          <summary style={{ cursor: "pointer" }}><strong>{pick(locale, L.sectionAutoHandled)}（{autoHandled.length}）</strong></summary>
          <p className="overview-note">{pick(locale, L.autoHandledNote)}</p>
          {autoHandled.length === 0 ? <p className="overview-note">{pick(locale, L.emptyNeedsHuman)}</p> : (
            <table className="scenario-table">
              <TableHead locale={locale} />
              <tbody>{autoHandled.map((report) => <ReportRow report={report} locale={locale} key={report.id} />)}</tbody>
            </table>
          )}
        </details>
      </div>

      <div className="panel">
        <details>
          <summary style={{ cursor: "pointer" }}><strong>{pick(locale, L.sectionRunFailures)}（{runFailures.length}）</strong></summary>
          {runFailures.length === 0 ? <p className="overview-note">{pick(locale, L.empty)}</p> : (
            <table className="scenario-table">
              <TableHead locale={locale} />
              <tbody>{runFailures.map((report) => <ReportRow report={report} locale={locale} key={report.id} />)}</tbody>
            </table>
          )}
        </details>
      </div>
    </AppShell>
  );
}
