import { NextRequest, NextResponse } from "next/server";
import { setConnectionStatus } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { id } = await context.params;
  await setConnectionStatus(Number(id), "disconnected", organization.id);
  return NextResponse.json({ status: "disconnected" });
}
