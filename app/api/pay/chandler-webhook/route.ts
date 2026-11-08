import { NextRequest, NextResponse } from "next/server";
import { processChandlerWebhook } from "@/lib/pay-webhook";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Chandler 支付结果 webhook（契约 M3-T0 §3）：验签 → 事件落库 → 订单状态机推进；未知单 404 让平台重试。 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const result = await processChandlerWebhook(rawBody, request.headers.get("x-chandler-signature"));
  return NextResponse.json(result.body, { status: result.status });
}
