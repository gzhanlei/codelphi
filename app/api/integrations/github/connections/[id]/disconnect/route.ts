import { NextRequest, NextResponse } from "next/server";
import { setConnectionStatus } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  await setConnectionStatus(Number(id), "disconnected");
  return NextResponse.json({ status: "disconnected" });
}
