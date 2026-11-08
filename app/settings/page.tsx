import Link from "next/link";
import { AppShell } from "@/components/app-shell";
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

/** 账户设置页（M4-T1，§8.3 全清单）：余额一律读钱包（唯一事实源）；周期用语为「当前计费周期」。 */
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
    `SELECT COUNT(*) AS count, MAX(created_at) AS lastAt FROM skipped_pushes sp
     JOIN repositories repo ON repo.id = sp.repository_id WHERE repo.product_id IN (SELECT id FROM products WHERE organization_id = ?)`,
    [accountId],
  );
  const skipped = (skippedRows as Array<{ count: number; lastAt: string | Date | null }>)[0] ?? { count: 0, lastAt: null };

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

  const isTrial = (account?.plan_status ?? "trialing") === "trialing";
  const hold = Boolean(account?.reconciliation_hold);

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">SETTINGS</span><h1>设置</h1><p>账户、套餐与额度的统一入口。</p></div>
      </div>

      {hold ? <div className="panel"><p className="error-text">账户正在对账冻结：暂时无法发起新分析；已有预留与分析结果不受影响，完成后自动解除。</p></div> : null}

      <div className="panel">
        <h2>账户与套餐</h2>
        <p>当前套餐：<strong>{account?.plan_id ?? "trial"}</strong> · 状态：<strong>{STATUS_LABEL[account?.plan_status ?? "trialing"] ?? account?.plan_status}</strong></p>
        {isTrial ? (
          <p>试用额度累计发放、不按周期重置；升级付费后剩余试用额度保留并优先消耗。</p>
        ) : (
          <p>当前计费周期：{formatDate(account?.current_period_start)} → {formatDate(account?.current_period_end)}；下次额度重置时间：{formatDate(account?.current_period_end)}</p>
        )}
        {account?.grace_until && account.plan_status === "grace" ? <p className="error-text">宽限期至 {formatDate(account.grace_until)}：期间无法发起新分析，续费立即恢复。</p> : null}
        <p><Link href="/pricing" className="text-button">升级 / 续费 / 购买超额包 →</Link></p>
      </div>

      <div className="panel">
        <h2>额度（当前计费周期可用）</h2>
        <p>可用额度：<strong>{available} SAU</strong>{used > 0 ? ` · 预留中 ${used} SAU` : ""}</p>
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
        <p className="sidebar-note">失败的分析不扣额度（释放计数：{failedReleased}）；结算异常待人工确认：{openExceptions}。</p>
      </div>

      <div className="panel">
        <h2>自动分析跳过（额度不足时静默跳过、零费用）</h2>
        <p>跳过次数：<strong>{Number(skipped.count)}</strong> · 最近一次：{formatDate(skipped.lastAt)}</p>
        <p>购买额度或进入新周期后，可在对应产品页使用「补分析最新提交」恢复规格同步（按新任务正常计费）。</p>
      </div>

      <div className="panel">
        <h2>最近订单</h2>
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
      </div>
    </AppShell>
  );
}
