import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listNotificationChannels, saveNotificationChannel } from "@/lib/notifications";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

const channelSchema = z.object({
  kind: z.enum(["slack", "webhook"]),
  target: z.string().trim().url().max(1000).refine((value) => value.startsWith("https://") || value.startsWith("http://"), {
    message: "通知目标必须是 http(s) webhook 地址",
  }),
});

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  return NextResponse.json({ channels: await listNotificationChannels(access.product.id) });
}

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  const parsed = channelSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参数无效" }, { status: 400 });
  await saveNotificationChannel(access.product.id, parsed.data.kind, parsed.data.target);
  return NextResponse.json({ status: "saved" }, { status: 201 });
}

// 影子对比修复后的链路验证注释。

// 影子调试注释第二发。

// I1 修复后的窄推送回归验证注释。
