import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { verifyApiKey } from "@/lib/mcp/api-keys";
import { assembleJsonBody } from "@/lib/chunked-upload";
import { CONTRACT_VERSION } from "@/lib/extraction-contract";
import { ImportValidationError, importSnapshotArtifact } from "@/lib/snapshot-import";

export const runtime = "nodejs";


/**
 * 请求体组装走共用的分块上传（lib/chunked-upload.ts）：单发或按 x-import-* 头分块，每个 key 每小时 10 次完整上传。
 */
const assembleBody = (request: NextRequest, identity: { keyId: number; organizationId: number }) =>
  assembleJsonBody(request, identity, { name: "snapshot-import", limit: 10, windowSeconds: 3600 });


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
  let artifact: unknown;
  try {
    artifact = await assembleBody(request, identity);
  } catch (error) {
    if (error instanceof Error && error.message === "rate_limited") {
      return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "3600" } });
    }
    if (error instanceof Error && error.message === "invalid_chunk") {
      return NextResponse.json({ error: "invalid_chunk" }, { status: 400 });
    }
    if (error instanceof Error && error.message === "__chunk_wait__") {
      return NextResponse.json({ received: true });
    }
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    // 单事务：导入失败（含 FK/规模异常）整体回滚，不留孤儿产品/功能行
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      const receipt = await importSnapshotArtifact(
        { execute: connection.execute.bind(connection) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>, currentContractVersion: CONTRACT_VERSION, organizationId: identity.organizationId },
        artifact,
      );
      await connection.commit();
      return NextResponse.json({ imported: receipt.mode !== "idempotent", idempotent: receipt.mode === "idempotent", ...receipt });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    if (error instanceof ImportValidationError) {
      if (error.code === "artifact_contains_source") {
        // 旧客户端的快照带源码摘录：请求体没有落任何表。回执里带上最低版本和「请升级」；状态码沿用导入其余错误的 409（修订稿 §4.2）。
        return NextResponse.json({ error: error.code, message: error.message, ...((error.details as { minClientVersion?: string } | undefined)?.minClientVersion ? { minClientVersion: (error.details as { minClientVersion: string }).minClientVersion } : {}) }, { status: 409 });
      }
      const status = error.code === "invalid_artifact" || error.code === "duplicate_reference" ? 400 : 409;
      return NextResponse.json({ error: error.code, message: error.message, details: error.details ?? null }, { status });
    }
    console.error("[snapshot-import] unexpected failure", error);
    return NextResponse.json({ error: "import_failed" }, { status: 500 });
  }
}
