import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { grantQuotaByEmail } from "@/lib/billing/manual-grant";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  email: z.string().email(),
  units: z.number().int().positive().max(100_000),
  reason: z.string().min(4).max(120),
});

/** 手工充值（超管）：给任意用户（按邮箱）的 Trial 钱包发放 SAU；同一 reason 幂等（不重复发放）。 */
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

  try {
    const result = await grantQuotaByEmail({
      email: parsed.data.email,
      units: parsed.data.units,
      reason: parsed.data.reason,
      operator: user.email ?? user.sub,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "充值失败";
    // 定位类失败（无用户/无工作区）→ 404 语义；其余 500（服务端账务问题不静默）
    if (message.includes("no user") || message.includes("no personal workspace")) {
      return NextResponse.json({ error: "target_not_found", message }, { status: 404 });
    }
    console.error("[billing] manual grant failed", error);
    return NextResponse.json({ error: "grant_failed", message }, { status: 500 });
  }
}
