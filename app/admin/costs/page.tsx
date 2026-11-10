import { AppShell } from "@/components/app-shell";
import { currentOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { requireSessionUser } from "@/lib/session";
import { buildCostReport } from "@/lib/billing/cost-observability";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

const CURRENCY = "¥";

function money(value: number) {
  return `¥${value.toFixed(4)}`;
}

/** R5 成本分布观测（超管后台）：每 run 实际成本、分位、影子/独立生成拆分——单 SAU 毛利复核的数据基础。 */
export default async function CostAdminPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  await requirePlatformAdmin(user, organization);
  const days = Math.min(90, Math.max(1, Number((await searchParams).days ?? 14) || 14));
  const report = await buildCostReport(getDb().execute.bind(getDb()), days);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">COST ADMIN</span><h1>成本观测</h1><p>最近 {days} 天的 LLM 调用实际成本（llm_call_receipts 汇总）。成本 NULL = 单价未配置，按 0 计入行并单独披露调用数——未定价 ≠ 零成本。</p></div>
        <div className="page-actions">
          {[7, 14, 30].map((option) => (
            <a key={option} className={`secondary-button${option === days ? " active" : ""}`} href={`/admin/costs?days=${option}`}>{option} 天</a>
          ))}
        </div>
      </div>

      <section className="overview-panel">
        <div className="overview-panel-heading"><span>01</span><h2>汇总</h2></div>
        <div className="stats-grid">
          <div className="stat-card"><span>主链路成本</span><strong>{money(report.totalMainCost)}</strong><small>{report.runCount} 个 run</small></div>
          <div className="stat-card"><span>影子对比成本</span><strong>{money(report.totalShadowCost)}</strong><small>占比 {(report.shadowShare * 100).toFixed(1)}%</small></div>
          <div className="stat-card"><span>独立生成成本</span><strong>{money(report.totalStandaloneCost)}</strong><small>intro_material 等（无 run）</small></div>
          <div className="stat-card"><span>每 run 主链路</span><strong>P50 {money(report.percentiles.p50)}</strong><small>P95 {money(report.percentiles.p95)} · P99 {money(report.percentiles.p99)}</small></div>
        </div>
        {report.unpricedCalls > 0 ? <p className="overview-error">未定价调用 {report.unpricedCalls} 条（usage 已知但单价缺失）——核对 LLM_PRICES 配置。</p> : <p className="overview-note">窗口内无未定价调用。</p>}
      </section>

      <section className="overview-panel">
        <div className="overview-panel-heading"><span>02</span><h2>按产品</h2></div>
        <table className="data-table">
          <thead><tr><th>产品</th><th>run 数</th><th>主链路</th><th>影子</th><th>平均每 run</th></tr></thead>
          <tbody>
            {report.byProduct.length === 0 ? <tr><td colSpan={5}>窗口内无分析。</td></tr> : report.byProduct.map((entry) => (
              <tr key={entry.productName}>
                <td>{entry.productName}</td>
                <td>{entry.runCount}</td>
                <td>{money(entry.mainCost)}</td>
                <td>{money(entry.shadowCost)}</td>
                <td>{money(entry.avgCostPerRun)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="overview-panel">
        <div className="overview-panel-heading"><span>03</span><h2>最近 run</h2></div>
        <table className="data-table">
          <thead><tr><th>run</th><th>产品</th><th>时间</th><th>主链路</th><th>影子</th><th>输入/输出/缓存 tok</th></tr></thead>
          <tbody>
            {report.runs.length === 0 ? <tr><td colSpan={6}>窗口内无 run。</td></tr> : report.runs.map((run) => (
              <tr key={run.runId}>
                <td>{run.runId}</td>
                <td>{run.productName}</td>
                <td>{new Date(run.createdAt).toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}</td>
                <td>{money(run.mainCost)}</td>
                <td>{money(run.shadowCost)}</td>
                <td>{run.inputTokens} / {run.outputTokens} / {run.cacheHitTokens}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="overview-note">对照定价：1 SAU = {CURRENCY}0.99。毛利 = SAU 收入 − 每 run 成本（上表）；连续两周低于成本线须复核定价模型。</p>
      </section>
    </AppShell>
  );
}
