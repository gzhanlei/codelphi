import { NextRequest, NextResponse } from "next/server";
import { getCodeHostingAdapter } from "@/lib/code-hosting";
import { repositoryListErrorResponse } from "@/lib/repository-list-response";
import { requireOrganization } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function positiveInteger(value: string | null, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

export async function GET(request: NextRequest) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const provider = request.nextUrl.searchParams.get("provider") ?? "github";
  const connectionId = positiveInteger(request.nextUrl.searchParams.get("connectionId"), Number.MAX_SAFE_INTEGER);
  const page = positiveInteger(request.nextUrl.searchParams.get("page") ?? "1", 5);
  if (connectionId === null || page === null) return NextResponse.json({ error: "请选择 GitHub App 连接和有效页码" }, { status: 400 });
  try {
    const result = await getCodeHostingAdapter(provider).listRepositories({ connectionId, organizationId: organization.id }, page);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return repositoryListErrorResponse(error);
  }
}
