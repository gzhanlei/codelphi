import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { WorkspaceTriggerDefaultSettings } from "@/components/workspace-trigger-default-settings";
import { getWorkspaceTriggerDefault } from "@/lib/analysis-trigger";
import { getDb } from "@/lib/db";
import { requireSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  trialing: "试用中（累计额度，不按周期重置）",
  active: "生效中",
  grace: "宽限期（只读）",
  expired: "已到期",
};

const WALLET_LABEL: Record<string, string> = { trial: "试用额度", plan: "套餐额度", gift: "活动赠送", pack: "超额包" };

function formatDate(value: unknown) {
  if (!value) return "—";
  return new Date(value as string).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}

/** 账户设置页：套餐额度状态 + 工作区级设置 + 各产品分析入口 + 订单记录。 */
export default async function SettingsPage() {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  const db = getDb();
  const accountId = organization.id;

  const [accountRows] = await db.execute(
    `SELECT plan_id, plan_status, current_period_start, current_period_end, grace_until, reconciliation_hold
     FROM billing_accounts WHERE account_id = ?`,
    [accountId],
  );
  const account = (accountRows as Array<{ plan_id: string; plan_status: string; current_period_start: string | Date | null; current_period_end: string | Date | null; grace_until: string | Date | null; reconciliation_hold: number }>)[0];

  const [walletRows] = await db.execute(
    `SELECT wallet_id, quota_type, remaining_sau, reserved_sau, status, expires_at, source_key, period_id
     FROM billing_quota_wallets WHERE account_id = ? ORDER BY wallet_id ASC`,
    [accountId],
  );
  const wallets = walletRows as Array<{ wallet_id: number; quota_type: string; remaining_sau: number; reserved_sau: number; status: string; expires_at: string | Date | null; source_key: string | null; period_id: string | null }>;
  const available = wallets.filter((w) => w.status === "active").reduce((sum, w) => sum + (w.remaining_sau - w.reserved_sau), 0);
  const used = wallets.filter((w) => w.status === "active").reduce((sum, w) => sum + w.reserved_sau, 0);

  const [skippedRows] = await db.execute(
    `SELECT sp.repository_id AS repositoryId, COUNT(*) AS count, MAX(sp.created_at) AS lastAt FROM skipped_pushes sp
     JOIN repositories repo ON repo.id = sp.repository_id WHERE repo.product_id IN (SELECT id FROM products WHERE organization_id = ?)
     GROUP BY sp.repository_id ORDER BY count DESC`,
    [accountId],
  );
  const skippedByRepo = skippedRows as Array<{ repositoryId: number; count: number; lastAt: string | Date | null }>;

  const [failedRows] = await db.execute(
    `SELECT COUNT(*) AS count FROM billing_ledger WHERE account_id = ? AND action = 'released' AND reason IN ('analysis_failed', 'ttl_expired')`,
    [accountId],
  );
  const failedReleased = Number((failedRows as Array<{ count: number }>)[0]?.count ?? 0);

  const [orderRows] = await db.execute(
    `SELECT order_no, kind, status, refund_status, amount, created_at, paid_at FROM payment_orders
     WHERE account_id = ? ORDER BY created_at DESC LIMIT 10`,
    [accountId],
  );
  const orders = orderRows as Array<{ order_no: string; kind: string; status: string; refund_status: string; amount: number; created_at: string | Date; paid_at: string | Date | null }>;

  const [exceptionRows] = await db.execute(
    `SELECT COUNT(*) AS count FROM billing_settlement_exceptions WHERE account_id = ? AND reconciliation_status = 'open'`,
    [accountId],
  );
  const openExceptions = Number((exceptionRows as Array<{ count: number }>)[0]?.count ?? 0);

  const [productRows] = await db.execute(
    `SELECT id, slug, name FROM products WHERE organization_id = ? ORDER BY name`,
    [accountId],
  );
  const products = productRows as Array<{ id: number; slug: string; name: string }>;
  const skippedByProduct = new Map<number, { count: number; lastAt: string | Date | null }>();
  const [repoProductRows] = await db.execute(
    `SELECT id, product_id FROM repositories WHERE product_id IN (SELECT id FROM products WHERE organization_id = ?)`,
    [accountId],
  ) as [Array<{ id: number; product_id: number }>, unknown];
  const repoToProduct = new Map(repoProductRows.map((row) => [row.id, row.product_id]));
  for (const entry of skippedByRepo) {
    const productId = repoToProduct.get(entry.repositoryId);
    if (productId === undefined) continue;
    skippedByProduct.set(productId, entry);
  }

  const workspaceDefault = await getWorkspaceTriggerDefault(accountId);
  const isTrial = (account?.plan_status ?? "trialing") === "trialing";
  const hold = Boolean(account?.reconciliation_hold);
  const canEdit = organization.role !== "viewer";

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">SETTINGS</span><h1>设置</h1><p>套餐额度、分析触发与订单记录的统一入口；各产品的成员、通知等设置在对应产品页内。</p></div>
      </div>

      {hold ? <div className="overview-panel"><p className="overview-error">账户正在对账冻结：暂时无法发起新分析；已有预留与分析结果不受影响，完成后自动解除。</p></div> : null}

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>01</span><h2>套餐与额度</h2></div>
        <div className="stats-grid">
          <div className="stat-card"><span>可用额度</span><strong>{available}</strong><small>SAU · 当前周期</small></div>
          <div className="stat-card"><span>预留中</span><strong>{used}</strong><small>在途分析占用</small></div>
          <div className="stat-card"><span>套餐状态</span><strong style={{ fontSize: 18 }}>{STATUS_LABEL[account?.plan_status ?? "trialing"] ?? account?.plan_status ?? "试用中"}</strong><small>{account?.plan_id ?? "trial"}</small></div>
        </div>
        {isTrial ? (
          <p className="overview-note">试用额度累计发放、不按周期重置；升级付费后剩余试用额度保留并优先消耗。</p>
        ) : (
          <p className="overview-note">当前计费周期：{formatDate(account?.current_period_start)} → {formatDate(account?.current_period_end)}；下次额度重置：{formatDate(account?.current_period_end)}</p>
        )}
        {account?.grace_until && account.plan_status === "grace" ? <p className="overview-error">宽限期至 {formatDate(account.grace_until)}：期间无法发起新分析，续费立即恢复。</p> : null}
        {openExceptions > 0 ? <p className="overview-error">结算异常待人工确认：{openExceptions} 条。</p> : null}
        <p className="overview-note">失败的分析不扣额度（累计释放 {failedReleased} 次）。<Link href="/pricing" className="text-button">升级 / 续费 / 购买超额包 →</Link></p>
      </section>

      <WorkspaceTriggerDefaultSettings canEdit={canEdit} current={workspaceDefault} />

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>03</span><h2>各产品分析设置</h2></div>
        <p className="overview-note">触发模式、通知渠道、成员权限等设置在每个产品的「设置」页内管理；额度不足被跳过的自动推送，可在产品页用「补分析最新提交」恢复同步。</p>
        {products.map((product) => {
          const skipped = skippedByProduct.get(product.id);
          return (
            <div key={product.id} className="settings-form" style={{ marginBottom: 14 }}>
              <p style={{ fontWeight: 650, margin: "0 0 4px" }}>
                <Link href={`/products/${organization.slug}/${product.slug}?view=settings`}>{product.name}</Link>
                <span style={{ fontWeight: 400 }}> · 设置 →</span>
              </p>
              <p className="overview-note" style={{ margin: 0 }}>
                {skipped ? `自动分析跳过 ${skipped.count} 次（最近 ${formatDate(skipped.lastAt)}）——恢复同步请到产品页「补分析最新提交」` : "无被跳过的自动分析"}
              </p>
            </div>
          );
        })}
        {products.length === 0 ? <p className="overview-note">尚未接入产品。</p> : null}
      </section>

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>04</span><h2>额度钱包</h2></div>
        <table className="data-table">
          <thead><tr><th>类型</th><th>状态</th><th>剩余</th><th>预留中</th><th>到期</th></tr></thead>
          <tbody>
            {wallets.map((wallet) => (
              <tr key={wallet.wallet_id}>
                <td>{WALLET_LABEL[wallet.quota_type] ?? wallet.quota_type}</td>
                <td>{wallet.status}</td>
                <td>{wallet.remaining_sau}</td>
                <td>{wallet.reserved_sau}</td>
                <td>{wallet.expires_at ? formatDate(wallet.expires_at) : "—"}</td>
              </tr>
            ))}
            {wallets.length === 0 ? <tr><td colSpan={5}>尚无额度钱包。</td></tr> : null}
          </tbody>
        </table>
      </section>

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>05</span><h2>最近订单</h2></div>
        <table className="data-table">
          <thead><tr><th>单号</th><th>类型</th><th>状态</th><th>退款</th><th>金额</th><th>创建</th></tr></thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.order_no}>
                <td>{order.order_no.slice(0, 18)}…</td>
                <td>{order.kind}</td>
                <td>{order.status}</td>
                <td>{order.refund_status}</td>
                <td>¥{(order.amount / 100).toFixed(2)}</td>
                <td>{formatDate(order.created_at)}</td>
              </tr>
            ))}
            {orders.length === 0 ? <tr><td colSpan={6}>暂无订单。</td></tr> : null}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
