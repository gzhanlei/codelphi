import { NextRequest, NextResponse } from "next/server";
import { checkGitHubConnection } from "@/lib/github-connections";
import { requireSessionUser } from "@/lib/session";

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  const result = await checkGitHubConnection(Number(id));
  return NextResponse.json(result.body, { status: result.status });
}
