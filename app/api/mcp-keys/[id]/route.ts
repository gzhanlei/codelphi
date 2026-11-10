import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireOrganization } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";
import { revokeApiKey } from "@/lib/mcp/api-keys";

export const runtime = "nodejs";

const FORBIDDEN = { error: "只有工作区成员可以管理 MCP key" };

/** 软撤销 MCP API key（组织级 editor/owner；撤销后该 key 立即失效，审计保留）。 */
export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "key 不存在" }, { status: 404 });
  const revoked = await revokeApiKey(getDb(), organization.id, id);
  if (!revoked) return NextResponse.json({ error: "key 不存在或已撤销" }, { status: 404 });
  return NextResponse.json({ status: "revoked" });
}
