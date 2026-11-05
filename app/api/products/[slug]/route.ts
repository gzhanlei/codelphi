import { NextRequest, NextResponse } from "next/server";
import { updateProductDescription } from "@/lib/product-description";
import { requireOrganization } from "@/lib/organizations";
import { descriptionUpdateSchema } from "@/lib/product-input";
import { productRemovalError, removeProduct } from "@/lib/product-removal";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { slug } = await context.params;
  const parsed = descriptionUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "概况内容无效" }, { status: 400 });
  const result = await updateProductDescription(slug, organization.id, parsed.data.description.trim());
  if (!result) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  return NextResponse.json({ status: "updated", description: result.description });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  try {
    const { slug } = await context.params;
    await removeProduct(slug, organization.id);
    return NextResponse.json({ status: "deleted" });
  } catch (error) {
    const { status, message } = productRemovalError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
