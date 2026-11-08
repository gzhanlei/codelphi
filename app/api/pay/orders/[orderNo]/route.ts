import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getOrderWithReconcile } from "@/lib/pay-orders";
import { findUserIdBySub } from "@/lib/users";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 查单（契约 §2.2）：本人订单；pending > 20s 未收 webhook 时向 Chandler 对账一次。 */
export async function GET(_request: NextRequest, context: { params: Promise<{ orderNo: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { orderNo } = await context.params;
  const userId = await findUserIdBySub(user.sub);
  if (userId === null) return NextResponse.json({ error: "user_not_found" }, { status: 401 });
  const order = await getOrderWithReconcile(orderNo, userId);
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  return NextResponse.json(order);
}
