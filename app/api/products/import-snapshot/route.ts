import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { verifyApiKey } from "@/lib/mcp/api-keys";
import { consumeRateLimit } from "@/lib/rate-limit";
import { CONTRACT_VERSION } from "@/lib/extraction-contract";
import { ImportValidationError, importSnapshotArtifact } from "@/lib/snapshot-import";

export const runtime = "nodejs";

/**
 * BYO 快照导入端点（设计 2026-11-18-radar-import-byo §4/§9，2026-11-19）：
 * 授权 = Bearer API key 且 scope='snapshot_write'（mcp_read key 一律 403）；组织作用域取自 key。
 * 错误映射：invalid_artifact 400 / contract_version_mismatch、product_has_content 409 / 其余 500。
 * 限流：复用 lib/rate-limit 的用户档（每 key 每小时 10 次，§9）。
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const db = getDb();
  const identity = token ? await verifyApiKey({ execute: db.execute.bind(db) }, token) : null;
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (identity.scope !== "snapshot_write") {
    return NextResponse.json({ error: "forbidden", reason: "this endpoint requires a snapshot_write key" }, { status: 403 });
  }
  const limit = await consumeRateLimit({ kind: "user", identity: `snapshot-import:${identity.keyId}`, limit: 10, windowSeconds: 3600 });
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  }

  let artifact: unknown;
  try {
    artifact = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const receipt = await importSnapshotArtifact(
      { execute: db.execute.bind(db) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>, currentContractVersion: CONTRACT_VERSION, organizationId: identity.organizationId },
      artifact,
    );
    return NextResponse.json({ imported: receipt.mode !== "idempotent", idempotent: receipt.mode === "idempotent", ...receipt });
  } catch (error) {
    if (error instanceof ImportValidationError) {
      const status = error.code === "invalid_artifact" || error.code === "duplicate_reference" ? 400 : 409;
      return NextResponse.json({ error: error.code, message: error.message, details: error.details ?? null }, { status });
    }
    console.error("[snapshot-import] unexpected failure", error);
    return NextResponse.json({ error: "import_failed" }, { status: 500 });
  }
}
