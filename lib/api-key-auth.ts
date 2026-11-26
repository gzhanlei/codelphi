import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "./db";
import { verifyApiKey } from "./mcp/api-keys";

export interface SnapshotWriteIdentity {
  keyId: number;
  organizationId: number;
}

/**
 * 用 Bearer API key 鉴权，而且必须是 snapshot_write 权限的 key；组织取自 key。
 * 客户端分析的两个端点（上传提案、取上下文）共用。不通过时给一个可以直接返回的响应。
 */
export async function requireSnapshotWriteKey(request: NextRequest): Promise<{ identity: SnapshotWriteIdentity } | { response: NextResponse }> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const db = getDb();
  const identity = token ? await verifyApiKey({ execute: db.execute.bind(db) }, token) : null;
  if (!identity) return { response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (identity.scope !== "snapshot_write") {
    return { response: NextResponse.json({ error: "forbidden", reason: "this endpoint requires a snapshot_write key" }, { status: 403 }) };
  }
  return { identity: { keyId: identity.keyId, organizationId: identity.organizationId } };
}
