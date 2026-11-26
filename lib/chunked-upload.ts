import type { NextRequest } from "next/server";
import { consumeRateLimit } from "./rate-limit";

/**
 * 分块上传的请求体组装（2026-11-19 分片上传，BYO 快照导入首创，客户端提案上传沿用）：
 * 没有分片头就是单发整体；带 x-import-* 头则按 (organizationId, importId) 累积分块，末块组装成完整 JSON 并计一次限流。
 * 分块让 nginx 请求体上限退化为「单块传输参数」而非产品规模天花板。
 * 组装态只存内存（单实例部署拓扑），30 分钟无进展惰性过期。
 * 限流对每一次完整的上传计一次，不论分没分块。（2026-11-27 之前只对分块上传计数，单发的上传不受限，
 * 和「每个 key 每小时 10 次」的说法不符；两个端点共用这里，一起改正。）
 *
 * 失败用 Error 的 message 表示原因，调用方按 message 映射状态码：
 *   invalid_chunk  分片头不合法（400）
 *   __chunk_wait__ 还没收齐，不是错误（202）
 *   rate_limited   这个 key 在窗口内的次数用完了（429）
 */

interface PartialUpload {
  parts: Map<number, Buffer>;
  total: number;
  expires: number;
}

const uploadsByScope = new Map<string, Map<string, PartialUpload>>();
const UPLOAD_TTL_MS = 30 * 60_000;
const CHUNK_HEADER_MAX_TOTAL = 1000;

export const CHUNKED_UPLOAD_ERRORS = { invalidChunk: "invalid_chunk", waiting: "__chunk_wait__", rateLimited: "rate_limited" } as const;

export interface UploadIdentity {
  keyId: number;
  organizationId: number;
}

/**
 * scope 把不同端点的分块隔开（一个端点一个常量，比如 "snapshot-import"），限流也按它分开记。
 * limit 是每个 key 在 windowSeconds 内完整上传的次数：每次完整上传计一次，分片的确认不计。
 */
export async function assembleJsonBody(request: NextRequest, identity: UploadIdentity, scope: { name: string; limit: number; windowSeconds: number }): Promise<unknown> {
  const admit = async (body: Buffer): Promise<string> => {
    const limit = await consumeRateLimit({ kind: "user", identity: `${scope.name}:${identity.keyId}`, limit: scope.limit, windowSeconds: scope.windowSeconds });
    if (!limit.allowed) throw new Error(CHUNKED_UPLOAD_ERRORS.rateLimited);
    return body.toString("utf8");
  };
  const raw = Buffer.from(await request.arrayBuffer());
  const importId = request.headers.get("x-import-id");
  const indexHeader = request.headers.get("x-import-chunk-index");
  if (!importId || indexHeader === null) return JSON.parse(await admit(raw));

  const total = Number(request.headers.get("x-import-chunk-total"));
  const index = Number(indexHeader);
  if (!importId || importId.length > 64 || !Number.isInteger(total) || total < 1 || total > CHUNK_HEADER_MAX_TOTAL
    || !Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(CHUNKED_UPLOAD_ERRORS.invalidChunk);
  }
  const now = Date.now();
  let scopeUploads = uploadsByScope.get(scope.name);
  if (!scopeUploads) {
    scopeUploads = new Map();
    uploadsByScope.set(scope.name, scopeUploads);
  }
  for (const [key, entry] of scopeUploads) if (entry.expires < now) scopeUploads.delete(key);
  const uploadKey = `${identity.organizationId}#${importId}`;
  let entry = scopeUploads.get(uploadKey);
  if (!entry || entry.total !== total) {
    entry = { parts: new Map(), total, expires: now + UPLOAD_TTL_MS };
    scopeUploads.set(uploadKey, entry);
  }
  entry.parts.set(index, raw);
  entry.expires = now + UPLOAD_TTL_MS;
  if (entry.parts.size < total) {
    throw new Error(CHUNKED_UPLOAD_ERRORS.waiting);
  }
  const assembled = Buffer.concat(Array.from({ length: total }, (_, part) => entry!.parts.get(part)!));
  scopeUploads.delete(uploadKey);
  return JSON.parse(await admit(assembled));
}
