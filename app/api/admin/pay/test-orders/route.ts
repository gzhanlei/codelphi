import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { currentOrganization } from "@/lib/organizations";
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
  const result = await createPaymentOrder({
    accountId: organization.id,
    userId: Number(user.sub),
    kind: "test",
    channel: parsed.data.channel,
  });
  return NextResponse.json(result, { status: 201 });
}
