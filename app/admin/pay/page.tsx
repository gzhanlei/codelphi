import { AppShell } from "@/components/app-shell";
import { AdminPayOrders } from "@/components/admin-pay-orders";
import { AdminBillingGrant } from "@/components/admin-billing-grant";
import { getDb } from "@/lib/db";
import { currentOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { requireSessionUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** 支付管理（M3-T5 超管后台）：测试单 + 订单台账 + 退款操作；全部动作走既有 API（P4 五态由状态机推进）。 */
export default async function PayAdminPage() {
  const user = await requireSessionUser();
  const organization = await currentOrganization(user);
  await requirePlatformAdmin(user, organization);
  const db = getDb();
  const [orderRows] = await db.execute(
    `SELECT order_no, platform_order_no, kind, channel, amount, status, refund_status, refund_amount,
            created_at, paid_at, fulfilled_at
     FROM payment_orders ORDER BY created_at DESC, order_no DESC LIMIT 20`,
  );
  const orders = orderRows as Array<{
    order_no: string;
    platform_order_no: string | null;
    kind: string;
    channel: string;
    amount: number;
    status: string;
    refund_status: string;
    refund_amount: number | null;
    created_at: string | Date;
    paid_at: string | Date | null;
    fulfilled_at: string | Date | null;
  }>;

  return (
    <AppShell user={user} organizationName={organization.name}>
      <div className="page-heading">
        <div><span className="eyebrow">PAY ADMIN</span><h1>支付管理</h1><p>0.01 元联调测试单、订单台账与管理员退款（超时停 refund_submitted，由对账自动推进确认）。</p></div>
      </div>
      <AdminBillingGrant />
      <AdminPayOrders
        orders={orders.map((order) => ({
          ...order,
          created_at: String(order.created_at),
          paid_at: order.paid_at ? String(order.paid_at) : null,
          fulfilled_at: order.fulfilled_at ? String(order.fulfilled_at) : null,
        }))}
      />
    </AppShell>
  );
}
