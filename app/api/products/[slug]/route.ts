import { NextRequest, NextResponse } from "next/server";
import { updateProductDescription } from "@/lib/product-description";
import { requireOrganization } from "@/lib/organizations";
import { requireProductAccess } from "@/lib/product-access";
import { descriptionUpdateSchema } from "@/lib/product-input";
import { productRemovalError, removeProduct } from "@/lib/product-removal";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const NOT_FOUND = { error: "产品不存在或不属于当前工作区" };

export async function PATCH(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json(NOT_FOUND, { status: 404 });
  const parsed = descriptionUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "概况内容无效" }, { status: 400 });
  const result = await updateProductDescription(slug, access.product.organizationId, parsed.data.description.trim());
  if (!result) return NextResponse.json(NOT_FOUND, { status: 404 });
  return NextResponse.json({ status: "updated", description: result.description });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  // 删除产品是工作区级破坏性操作，仅工作区 editor/owner 可执行；产品级成员不可删除。
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
