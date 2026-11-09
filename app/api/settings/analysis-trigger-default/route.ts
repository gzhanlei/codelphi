import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireOrganization } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";
import { getWorkspaceTriggerDefault, updateWorkspaceTriggerDefault } from "@/lib/analysis-trigger";

export const runtime = "nodejs";

const schema = z.object({
  trigger: z.enum(["push", "daily", "push_count"]),
  n: z.number().int().min(2).max(20).optional(),
  hour: z.number().int().min(0).max(23).optional(),
});

const FORBIDDEN = { error: "只有工作区成员可以修改此设置" };

/** 工作区级分析触发默认：新接入的仓库继承（已有仓库不受影响）。 */
export async function PATCH(request: NextRequest) {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "触发模式无效" }, { status: 400 });
  const { trigger, n, hour } = parsed.data;
  if (trigger === "push_count" && (n ?? 5) < 2) return NextResponse.json({ error: "推送次数阈值至少为 2" }, { status: 400 });

  await updateWorkspaceTriggerDefault(organization.id, { trigger, n: n ?? 5, hour: hour ?? 3 });
  return NextResponse.json({ status: "updated", trigger, n: n ?? 5, hour: hour ?? 3 });
}

export async function GET() {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "viewer");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  const current = await getWorkspaceTriggerDefault(organization.id);
  return NextResponse.json({ status: "ok", ...current });
}
