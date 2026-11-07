import { NextRequest, NextResponse } from "next/server";
import { listProductMembers, inviteProductMember } from "@/lib/product-members";
import { requireProductAccess } from "@/lib/product-access";
import { requireSessionUser } from "@/lib/session";
import { defaultExecute } from "@/lib/db";

export const runtime = "nodejs";

const NOT_FOUND = { error: "产品不存在或不属于当前工作区" };

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json(NOT_FOUND, { status: 404 });
  const roster = await listProductMembers(access.product.id, access.product.organizationId);
  return NextResponse.json(roster);
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json(NOT_FOUND, { status: 404 });
  // 与工作区邀请一致：只有组织 owner 能邀请产品成员。
  if (access.via !== "organization" || access.role !== "owner") return NextResponse.json({ error: "只有工作区所有者可以邀请产品成员" }, { status: 403 });
  const body = await request.json().catch(() => null);
  try {
    const result = await inviteProductMember(user, access.organization, access.product, body, defaultExecute);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invite_failed";
    return NextResponse.json({ error: message === "forbidden" ? "没有邀请权限" : message }, { status: 400 });
  }
}
