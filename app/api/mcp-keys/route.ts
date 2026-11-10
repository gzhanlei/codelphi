import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { requireOrganization } from "@/lib/organizations";
import { requireSessionUser } from "@/lib/session";
import { createApiKey, listApiKeys } from "@/lib/mcp/api-keys";

export const runtime = "nodejs";

const FORBIDDEN = { error: "只有工作区成员可以管理 MCP key" };

/**
 * MCP API key 管理（A1 遗留收口：key 签发此前只有脚本路径）。
 * 组织级资源：editor/owner 可创建与查看（viewer 403）；明文只在创建响应出现一次。
 */

export async function GET() {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  return NextResponse.json({ keys: await listApiKeys(getDb(), organization.id) });
}

export async function POST(request: NextRequest) {
  const user = await requireSessionUser();
  let organization;
  try {
    organization = await requireOrganization(user, "editor");
  } catch {
    return NextResponse.json(FORBIDDEN, { status: 403 });
  }
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = String(body.name ?? "").trim().slice(0, 191);
  if (!name) return NextResponse.json({ error: "请填写 key 名称" }, { status: 400 });
  const created = await createApiKey(getDb(), { organizationId: organization.id, name, createdBy: user.sub });
  return NextResponse.json({
    key: { id: created.id, name },
    // 明文仅此一次（§4.1：库中只存哈希），前端必须提示立即保存
    plaintext: created.plaintext,
  });
}
