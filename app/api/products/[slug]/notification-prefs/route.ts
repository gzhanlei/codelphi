import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getUserEmailPref, setUserEmailPref } from "@/lib/notifications";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { findUserIdBySub } from "@/lib/users";

const prefSchema = z.object({ enabled: z.boolean() });

/** 当前登录用户对自己在该产品的邮件通知偏好（成员人人可设，含 viewer）。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const userId = await findUserIdBySub(user.sub);
  if (userId === null) return NextResponse.json({ enabled: false });
  return NextResponse.json({ enabled: await getUserEmailPref(access.product.id, userId) });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const parsed = prefSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  const userId = await findUserIdBySub(user.sub);
  if (userId === null) return NextResponse.json({ error: "用户尚未初始化，请刷新后重试" }, { status: 409 });
  await setUserEmailPref(access.product.id, userId, parsed.data.enabled);
  return NextResponse.json({ status: "saved" });
}
