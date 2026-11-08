import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { currentOrganization } from "@/lib/organizations";
import { findUserIdBySub } from "@/lib/users";
import { ChandlerTokenError } from "@/lib/chandler-token";
import { BillingError } from "@/lib/billing/core";
import { createPaymentOrder } from "@/lib/pay-orders";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({ channel: z.enum(["wechat", "alipay"]) });

/** 支付联调测试单（管理员，0.01 元）：走完整建单/支付/履约链路，履约不授予任何账务权益（kind=test 履约跳过）。 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const organization = await currentOrganization(user);
  try {
    await requirePlatformAdmin(user, organization);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const userId = await findUserIdBySub(user.sub);
  if (userId === null) return NextResponse.json({ error: "user_not_found" }, { status: 401 });
  try {
    const result = await createPaymentOrder({
      accountId: organization.id,
      userId,
      kind: "test",
      channel: parsed.data.channel,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ChandlerTokenError) {
      // token 未绑定/失效：引导重新登录（OAuth 会同步落库）
      return NextResponse.json({ error: "chandler_relogin_required", message: "支付凭证未同步，请退出后重新登录再试" }, { status: 409 });
    }
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: billing_status(error.code) });
    }
    const chandlerStatus = (error as { chandlerStatus?: number }).chandlerStatus;
    if (chandlerStatus === 409) return NextResponse.json({ error: "payment_unavailable", message: "支付通道暂未开放" }, { status: 409 });
    throw error;
  }
}

function billing_status(code: string) {
  return code === "quota_exceeded" ? 402 : 409;
}
