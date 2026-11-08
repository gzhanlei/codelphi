import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";
import { BillingError, billingHttpStatus } from "@/lib/billing/core";
import { createPaymentOrder, getOrderWithReconcile } from "@/lib/pay-orders";

export const runtime = "nodejs";
export const maxDuration = 300;

import { z } from "zod";

const kinds = z.enum(["subscription", "overage_pack", "test"]);

const createSchema = z.object({
  kind: kinds,
  planId: z.string().optional(),
  packSku: z.string().optional(),
  channel: z.enum(["wechat", "alipay"]),
});

/** 建单（契约 §2.1 四段边界）：本地 pending（复用）→ Chandler 建单（幂等键）→ 回写 → prepay。 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const organization = await currentOrganization(user);
  if (organization.role !== "owner") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  try {
    const result = await createPaymentOrder({
      accountId: organization.id,
      userId: Number(user.sub),
      kind: parsed.data.kind,
      planId: parsed.data.planId,
      packSku: parsed.data.packSku,
      channel: parsed.data.channel,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.code }, { status: billingHttpStatus(error.code) });
    }
    const chandlerStatus = (error as { chandlerStatus?: number }).chandlerStatus;
    if (chandlerStatus === 409) {
      // payment.* 业务错误（支付配置未就绪等）：透传语义，不落 failed 单
      return NextResponse.json({ error: "payment_unavailable" }, { status: 409 });
    }
    console.error("[billing] create payment order failed", error);
    return NextResponse.json({ error: "payment_unavailable" }, { status: 502 });
  }
}

/** 查单（契约 §2.2）：本人订单；pending > 20s 主动对账一次。 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orderNo = request.nextUrl.searchParams.get("orderNo");
  if (!orderNo) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const order = await getOrderWithReconcile(orderNo, Number(user.sub));
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  return NextResponse.json(order);
}
