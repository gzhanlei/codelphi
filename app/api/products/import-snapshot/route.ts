import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { verifyApiKey } from "@/lib/mcp/api-keys";
import { consumeRateLimit } from "@/lib/rate-limit";
import { CONTRACT_VERSION } from "@/lib/extraction-contract";
import { ImportValidationError, importSnapshotArtifact } from "@/lib/snapshot-import";

export const runtime = "nodejs";


/**
 * 请求体组装（2026-11-19 分片上传）：无分片头=单发整体；带 x-import-* 头则按
 * (organizationId, importId) 累积分块，末块组装为完整 JSON 并计一次限流。
 * 分块让 nginx 请求体上限退化为「单块传输参数」而非产品规模天花板。
 * 组装态只存内存（单实例部署拓扑），30 分钟无进展惰性过期。
 */
const chunkUploads = new Map<string, { parts: Map<number, Buffer>; total: number; expires: number }>();
const CHUNK_TTL_MS = 30 * 60_000;
const CHUNK_HEADER_MAX_TOTAL = 1000;

async function assembleBody(request: NextRequest, identity: { keyId: number; organizationId: number }): Promise<unknown> {
  const raw = Buffer.from(await request.arrayBuffer());
  const importId = request.headers.get("x-import-id");
  const indexHeader = request.headers.get("x-import-chunk-index");
  if (!importId || indexHeader === null) return JSON.parse(raw.toString("utf8"));

  const total = Number(request.headers.get("x-import-chunk-total"));
  const index = Number(indexHeader);
  if (!importId || importId.length > 64 || !Number.isInteger(total) || total < 1 || total > CHUNK_HEADER_MAX_TOTAL
    || !Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error("invalid_chunk");
  }
  const now = Date.now();
  for (const [key, entry] of chunkUploads) if (entry.expires < now) chunkUploads.delete(key);
  const uploadKey = `${identity.organizationId}#${importId}`;
  let entry = chunkUploads.get(uploadKey);
  if (!entry || entry.total !== total) {
    entry = { parts: new Map(), total, expires: now + CHUNK_TTL_MS };
    chunkUploads.set(uploadKey, entry);
  }
  entry.parts.set(index, raw);
  entry.expires = now + CHUNK_TTL_MS;
  if (entry.parts.size < total) {
    throw new Error("__chunk_wait__");
  }
  const assembled = Buffer.concat(Array.from({ length: total }, (_, part) => entry!.parts.get(part)!));
  chunkUploads.delete(uploadKey);
  const limit = await consumeRateLimit({ kind: "user", identity: `snapshot-import:${identity.keyId}`, limit: 10, windowSeconds: 3600 });
  if (!limit.allowed) throw new Error("rate_limited");
  return JSON.parse(assembled.toString("utf8"));
}


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
      const status = error.code === "invalid_artifact" || error.code === "duplicate_reference" ? 400 : 409;
      return NextResponse.json({ error: error.code, message: error.message, details: error.details ?? null }, { status });
    }
    console.error("[snapshot-import] unexpected failure", error);
    return NextResponse.json({ error: "import_failed" }, { status: 500 });
  }
}
