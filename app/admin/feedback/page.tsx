import { AppShell } from "@/components/app-shell";
import { FeedbackIssueButton } from "@/components/feedback-issue-button";
import { listFeedbackReports } from "@/lib/feedback";
import { currentOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { requireSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function FeedbackAdminPage() {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  await requirePlatformAdmin(user, organization);
  const reports = await listFeedbackReports();

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading"><div><span className="eyebrow">FEEDBACK ADMIN</span><h1>分析失败反馈</h1><p>自动收集的诊断信息，可一键转为 Radar GitHub Issue。</p></div></div>
      <div className="panel">
        {reports.length === 0 ? <p className="overview-note">暂无反馈。</p> : <table className="scenario-table">
          <thead><tr><th>产品 / 仓库</th><th>工作区</th><th>Revision</th><th>错误</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{reports.map((report) => <tr key={report.id}>
            <td><strong>{report.productName}</strong><br /><small>{report.repositoryFullName}</small></td>
            <td>{report.organizationName}</td>
            <td><code>{report.revision.slice(0, 7)}</code></td>
            <td><span className="feedback-error">{report.errorMessage}</span>{report.architectureError ? <small className="feedback-error">{report.architectureError}</small> : null}</td>
            <td>{report.status === "submitted" ? "已提交" : report.status === "failed" ? "提交失败" : "待处理"}</td>
            <td><FeedbackIssueButton id={report.id} issueUrl={report.githubIssueUrl} status={report.status} /></td>
          </tr>)}</tbody>
        </table>}
      </div>
    </AppShell>
  );
}
