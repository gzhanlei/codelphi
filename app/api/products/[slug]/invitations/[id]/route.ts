import { NextRequest, NextResponse } from "next/server";
import { cancelProductInvitation } from "@/lib/product-members";
import { requireProductAccess } from "@/lib/product-access";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function DELETE(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const user = await requireSessionUser();
  const { slug, id } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  if (access.via !== "organization" || access.role !== "owner") return NextResponse.json({ error: "只有工作区所有者可以取消邀请" }, { status: 403 });
  const invitationId = Number(id);
  if (!Number.isInteger(invitationId) || invitationId <= 0) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  const cancelled = await cancelProductInvitation(access.product.id, invitationId);
  if (!cancelled) return NextResponse.json({ error: "邀请不存在或已处理" }, { status: 404 });
  return NextResponse.json({ status: "cancelled" });
}
