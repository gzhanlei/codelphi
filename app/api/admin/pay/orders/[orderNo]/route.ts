import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { currentOrganization } from "@/lib/organizations";
import { getSessionUser } from "@/lib/session";
import { previewRefund, requestRefund } from "@/lib/pay-refunds";
import { BillingError } from "@/lib/billing/core";

export const runtime = "nodejs";
export const maxDuration = 300;

async function requireAdmin(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return null;
  const organization = await currentOrganization(user);
  try {
    return await requirePlatformAdmin(user, organization);
  } catch {
    return null;
  }
}

/** 退款试算（管理员，只读）：subscription 按剩余天数、pack 按剩余 SAU 折算。 */
export async function GET(request: NextRequest, context: { params: Promise<{ orderNo: string }> }) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { orderNo } = await context.params;
  const preview = await previewRefund(orderNo);
  return NextResponse.json(preview);
}

/** 退款（管理员，P4 五态）：refund_pending → Chandler 提交 → refund_submitted（超时）/ confirmed / failed。 */
export async function POST(request: NextRequest, context: { params: Promise<{ orderNo: string }> }) {
  if (!(await requireAdmin(request))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { orderNo } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { amount?: number; reason?: string };
  try {
    const result = await requestRefund(orderNo, { amount: body.amount, reason: body.reason });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof BillingError) {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 409 });
    }
    throw error;
  }

}
