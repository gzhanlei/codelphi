import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { WorkspaceTriggerDefaultSettings } from "@/components/workspace-trigger-default-settings";
import { WorkspaceOutputLanguageSettings } from "@/components/workspace-output-language-settings";
import { McpKeysSettings } from "@/components/mcp-keys-settings";
import { listApiKeys } from "@/lib/mcp/api-keys";
import { getWorkspaceTriggerDefault, getWorkspaceOutputLanguageDefault } from "@/lib/analysis-trigger";
import { resolveUiLocale } from "@/lib/ui-locale-server";
import { pick, type LocaleEntry } from "@/lib/ui-locale";
import { SETTINGS_PAGE } from "@/lib/ui-strings/workspace";
import { formatDateTimeIn } from "@/lib/format";
import { getDb } from "@/lib/db";
import { requireSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, LocaleEntry> = {
  trialing: SETTINGS_PAGE.statusTrialing,
  active: SETTINGS_PAGE.statusActive,
  grace: SETTINGS_PAGE.statusGrace,
  expired: SETTINGS_PAGE.statusExpired,
};

const WALLET_LABEL: Record<string, LocaleEntry> = { trial: SETTINGS_PAGE.walletTrial, plan: SETTINGS_PAGE.walletPlan, gift: SETTINGS_PAGE.walletGift, pack: SETTINGS_PAGE.walletPack };

function formatDate(locale: "zh-CN" | "en", value: unknown) {
  return formatDateTimeIn(locale, value);
}

/** 账户设置页：套餐额度状态 + 工作区级设置 + 各产品分析入口 + 订单记录。 */
export default async function SettingsPage() {
  const user = await requireSessionUser();
  const uiLocale = await resolveUiLocale();
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
  const L = SETTINGS_PAGE;

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">SETTINGS</span><h1>{pick(uiLocale, L.heading)}</h1><p>{pick(uiLocale, L.headingBody)}</p></div>
      </div>

      {hold ? <div className="overview-panel"><p className="overview-error">{pick(uiLocale, L.holdBanner)}</p></div> : null}

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>01</span><h2>{pick(uiLocale, L.planHeading)}</h2></div>
        <div className="stats-grid">
          <div className="stat-card"><span>{pick(uiLocale, L.statAvailable)}</span><strong>{available}</strong><small>{pick(uiLocale, L.statAvailableUnit)}</small></div>
          <div className="stat-card"><span>{pick(uiLocale, L.statReserved)}</span><strong>{used}</strong><small>{pick(uiLocale, L.statReservedUnit)}</small></div>
          <div className="stat-card"><span>{pick(uiLocale, L.statPlanStatus)}</span><strong style={{ fontSize: 18 }}>{STATUS_LABEL[account?.plan_status ?? "trialing"] ? pick(uiLocale, STATUS_LABEL[account?.plan_status ?? "trialing"]) : (account?.plan_status ?? pick(uiLocale, L.statusUnknown))}</strong><small>{account?.plan_id ?? "trial"}</small></div>
        </div>
        {isTrial ? (
          <p className="overview-note">{pick(uiLocale, L.trialNote)}</p>
        ) : (
          <p className="overview-note">{pick(uiLocale, L.periodPrefix)}{formatDate(uiLocale, account?.current_period_start)}{pick(uiLocale, L.periodSeparator)}{formatDate(uiLocale, account?.current_period_end)}{pick(uiLocale, L.periodResetPrefix)}{formatDate(uiLocale, account?.current_period_end)}</p>
        )}
        {account?.grace_until && account.plan_status === "grace" ? <p className="overview-error">{pick(uiLocale, L.gracePrefix)}{formatDate(uiLocale, account.grace_until)}{pick(uiLocale, L.graceSuffix)}</p> : null}
        {openExceptions > 0 ? <p className="overview-error">{pick(uiLocale, L.exceptionPrefix)}{openExceptions}{pick(uiLocale, L.exceptionSuffix)}</p> : null}
        <p className="overview-note">{pick(uiLocale, L.failedReleasedPrefix)}{failedReleased}{pick(uiLocale, L.failedReleasedSuffix)}<Link href="/pricing" className="text-button">{pick(uiLocale, L.upgradeLink)}</Link></p>
      </section>

      <WorkspaceTriggerDefaultSettings canEdit={canEdit} current={workspaceDefault} locale={uiLocale} />

      <WorkspaceOutputLanguageSettings canEdit={canEdit} current={await getWorkspaceOutputLanguageDefault(accountId)} locale={uiLocale} />

      <McpKeysSettings canManage={canEdit} initialKeys={await listApiKeys(db, organization.id)} locale={uiLocale} />

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>03</span><h2>{pick(uiLocale, L.productsHeading)}</h2></div>
        <p className="overview-note">{pick(uiLocale, L.productsNote)}</p>
        {products.map((product) => {
          const skipped = skippedByProduct.get(product.id);
          return (
            <div key={product.id} className="settings-form" style={{ marginBottom: 14 }}>
              <p style={{ fontWeight: 650, margin: "0 0 4px" }}>
                <Link href={`/products/${organization.slug}/${product.slug}?view=settings`}>{product.name}</Link>
                <span style={{ fontWeight: 400 }}>{pick(uiLocale, L.productSettingsSuffix)}</span>
              </p>
              <p className="overview-note" style={{ margin: 0 }}>
                {skipped ? `${pick(uiLocale, L.skippedPrefix)}${skipped.count}${pick(uiLocale, L.skippedMiddle)}${formatDate(uiLocale, skipped.lastAt)}${pick(uiLocale, L.skippedSuffix)}` : pick(uiLocale, L.noSkipped)}
              </p>
            </div>
          );
        })}
        {products.length === 0 ? <p className="overview-note">{pick(uiLocale, L.noProducts)}</p> : null}
      </section>

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>04</span><h2>{pick(uiLocale, L.walletHeading)}</h2></div>
        <table className="data-table">
          <thead><tr><th>{pick(uiLocale, L.walletType)}</th><th>{pick(uiLocale, L.walletStatus)}</th><th>{pick(uiLocale, L.walletRemaining)}</th><th>{pick(uiLocale, L.walletReserved)}</th><th>{pick(uiLocale, L.walletExpires)}</th></tr></thead>
          <tbody>
            {wallets.map((wallet) => (
              <tr key={wallet.wallet_id}>
                <td>{WALLET_LABEL[wallet.quota_type] ? pick(uiLocale, WALLET_LABEL[wallet.quota_type]) : wallet.quota_type}</td>
                <td>{wallet.status}</td>
                <td>{wallet.remaining_sau}</td>
                <td>{wallet.reserved_sau}</td>
                <td>{wallet.expires_at ? formatDate(uiLocale, wallet.expires_at) : "—"}</td>
              </tr>
            ))}
            {wallets.length === 0 ? <tr><td colSpan={5}>{pick(uiLocale, L.noWallets)}</td></tr> : null}
          </tbody>
        </table>
      </section>

      <section className="overview-panel settings-panel">
        <div className="overview-panel-heading"><span>05</span><h2>{pick(uiLocale, L.ordersHeading)}</h2></div>
        <table className="data-table">
          <thead><tr><th>{pick(uiLocale, L.orderNo)}</th><th>{pick(uiLocale, L.orderKind)}</th><th>{pick(uiLocale, L.orderStatus)}</th><th>{pick(uiLocale, L.orderRefund)}</th><th>{pick(uiLocale, L.orderAmount)}</th><th>{pick(uiLocale, L.orderCreated)}</th></tr></thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.order_no}>
                <td>{order.order_no.slice(0, 18)}…</td>
                <td>{order.kind}</td>
                <td>{order.status}</td>
                <td>{order.refund_status}</td>
                <td>¥{(order.amount / 100).toFixed(2)}</td>
                <td>{formatDate(uiLocale, order.created_at)}</td>
              </tr>
            ))}
            {orders.length === 0 ? <tr><td colSpan={6}>{pick(uiLocale, L.noOrders)}</td></tr> : null}
          </tbody>
        </table>
      </section>
    </AppShell>
  );
}
