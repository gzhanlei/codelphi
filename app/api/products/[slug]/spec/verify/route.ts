import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifySpecEntity } from "@/lib/spec-verification";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

const verifySchema = z.object({
  entityType: z.enum(["feature", "scenario"]),
  entityId: z.number().int().positive(),
});

/** P1 核实动作：editor 权限；双版本绑定入历史，工作表置 verified_at 并清漂移标记。 */
export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const parsed = verifySchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  try {
    await verifySpecEntity({
      productId: access.product.id,
      entityType: parsed.data.entityType,
      entityId: parsed.data.entityId,
      verifiedBy: user.email ?? user.sub,
    });
    return NextResponse.json({ status: "verified" });
  } catch (error) {
    if (error instanceof Error && error.message === "spec_entity_invalid") {
      return NextResponse.json({ error: "规格条目不存在或已删除" }, { status: 404 });
    }
    if (error instanceof Error && error.message === "spec_version_missing") {
      return NextResponse.json({ error: "产品还没有规格快照，无法核实" }, { status: 409 });
    }
    throw error;
  }
}
