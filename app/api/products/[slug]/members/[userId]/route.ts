import { NextRequest, NextResponse } from "next/server";
import { removeProductMember } from "@/lib/product-members";
import { requireProductAccess } from "@/lib/product-access";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ slug: string; userId: string }> }) {
  const user = await requireSessionUser();
  const { slug, userId } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  if (access.via !== "organization" || access.role !== "owner") return NextResponse.json({ error: "只有工作区所有者可以移除产品成员" }, { status: 403 });
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  const result = await removeProductMember(access.product.id, access.product.organizationId, id);
  if (result === "organization_member") return NextResponse.json({ error: "该用户通过工作区访问，无法在产品维度移除" }, { status: 400 });
  if (result === "not_member") return NextResponse.json({ error: "该用户不是产品成员" }, { status: 404 });
  return NextResponse.json({ status: "removed" });
}
