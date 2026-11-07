import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteNotificationChannel, sendNotificationChannelTest, setNotificationChannelEnabled } from "@/lib/notifications";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

const patchSchema = z.object({ enabled: z.boolean() });

function channelId(context: { params: Promise<{ id: string }> }) {
  return context.params.then(({ id }) => {
    const parsed = Number(id);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("invalid_channel_id");
    return parsed;
  });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "参数无效" }, { status: 400 });
  try {
    await setNotificationChannelEnabled(access.product.id, await channelId(context), parsed.data.enabled);
    return NextResponse.json({ status: "updated" });
  } catch {
    return NextResponse.json({ error: "通知渠道不存在" }, { status: 404 });
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  try {
    await deleteNotificationChannel(access.product.id, await channelId(context));
    return NextResponse.json({ status: "deleted" });
  } catch {
    return NextResponse.json({ error: "通知渠道不存在" }, { status: 404 });
  }
}

/** 发送测试消息，验证渠道可达。 */
export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string; id: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  try {
    const result = await sendNotificationChannelTest(await channelId(context), access.product.name);
    if (result.productId !== access.product.id) return NextResponse.json({ error: "通知渠道不存在" }, { status: 404 });
    return NextResponse.json({ status: "sent" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "发送测试消息失败";
    return NextResponse.json({ error: message.includes("notification_channel_not_found") ? "通知渠道不存在" : `发送失败：${message}` }, { status: 502 });
  }
}
