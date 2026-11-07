import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setRegressionItem } from "@/lib/regression";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

const itemSchema = z.object({
  releaseId: z.number().int().positive(),
  specChangeId: z.number().int().positive(),
  status: z.enum(["pending", "verified", "skipped"]),
});

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const parsed = itemSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  try {
    await setRegressionItem({
      productId: access.product.id,
      releaseId: parsed.data.releaseId,
      specChangeId: parsed.data.specChangeId,
      status: parsed.data.status,
      checkedBy: user.email ?? user.sub,
    });
    return NextResponse.json({ status: "saved" });
  } catch (error) {
    if (error instanceof Error && error.message === "regression_item_invalid") {
      return NextResponse.json({ error: "该行为变化不属于此发布" }, { status: 404 });
    }
    throw error;
  }
}
