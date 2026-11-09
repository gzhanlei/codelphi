import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireProductAccess } from "@/lib/product-access";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const NOT_FOUND = { error: "产品不存在或不属于当前工作区" };

const triggerSchema = z.object({
  trigger: z.enum(["push", "daily", "push_count"]),
  n: z.number().int().min(2).max(20).optional(),
  hour: z.number().int().min(0).max(23).optional(),
});

/** 按仓库的分析触发模式设置（每次 push / 每天低峰一次 / 每 N 次 push + 当天兜底）。 */
export async function PATCH(request: NextRequest, context: { params: Promise<{ slug: string; repoId: string }> }) {
  const user = await requireSessionUser();
  const { slug, repoId } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json(NOT_FOUND, { status: 404 });
  const repositoryId = Number(repoId);
  if (!Number.isInteger(repositoryId)) return NextResponse.json({ error: "仓库 ID 无效" }, { status: 400 });

  const parsed = triggerSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "触发模式无效" }, { status: 400 });
  const { trigger, n, hour } = parsed.data;

  const [rows] = await getDb().execute(
    "SELECT id FROM repositories WHERE id = ? AND product_id = ? LIMIT 1",
    [repositoryId, access.product.id],
  ) as [Array<{ id: number }>, unknown];
  if (!rows[0]) return NextResponse.json(NOT_FOUND, { status: 404 });

  const triggerN = trigger === "push_count" ? (n ?? 5) : null;
  const triggerHour = trigger === "push" ? null : (hour ?? 3);
  await getDb().execute(
    "UPDATE repositories SET analysis_trigger = ?, analysis_trigger_n = ?, analysis_trigger_hour = ? WHERE id = ? AND product_id = ?",
    [trigger, triggerN, triggerHour, repositoryId, access.product.id],
  );
  return NextResponse.json({ status: "updated", repositoryId, trigger, n: triggerN, hour: triggerHour });
}
