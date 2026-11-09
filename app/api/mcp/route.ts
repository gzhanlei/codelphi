import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey } from "@/lib/mcp/api-keys";
import { verifyAccessToken } from "@/lib/mcp/oauth";
import { handleMcpRpc } from "@/lib/mcp/server";
import { getDb } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";

/**
 * A1 MCP server：Streamable HTTP（JSON 响应）端点，JSON-RPC 2.0。
 * 认证：API key（sk_cd_…，组织级只读）或 OAuth 访问 token（批准页签发）。
 * 限流：100 req/min per key（lib/rate-limit.ts）。只读工具面，越权返回空结果。
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const db = getDb();
  const executor = { execute: db.execute.bind(db) };
  // API key 身份或 OAuth token 身份二选一；都不通过即 401
  const keyIdentity = token ? await verifyApiKey(executor, token) : null;
  const oauthIdentity = keyIdentity ? null : token ? await verifyAccessToken(executor, token) : null;
  const identity = keyIdentity ?? oauthIdentity;
  if (!identity) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  }
  const limit = await consumeRateLimit({ kind: "user", identity: `mcp:${keyIdentity ? `key:${keyIdentity.keyId}` : `grant:${oauthIdentity!.grantId}`}`, limit: 100, windowSeconds: 60 });
  if (!limit.allowed) {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "Rate limited" } }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  const respond = async (item: unknown) => {
    if (item === null) return new NextResponse(null, { status: 202 });
    const status = (item as { error?: { code: number } }).error?.code === -32001 ? 401 : 200;
    return NextResponse.json(item, { status });
  };
  // Streamable HTTP：请求体可为单个消息或批量
  if (Array.isArray(body)) {
    const responses = [];
    for (const item of body) {
      const response = await handleMcpRpc({ execute: db.execute.bind(db), identity }, item as never);
      if (response) responses.push(response);
    }
    if (responses.length === 0) return new NextResponse(null, { status: 202 });
    return NextResponse.json(responses);
  }
  const response = await handleMcpRpc({ execute: db.execute.bind(db), identity }, body as never);
  return respond(response);
}

export async function GET() {
  // Streamable HTTP 的 GET 用于服务端流；本实现无服务端主动流，返回 405
  return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not allowed" } }, { status: 405 });
}
