import { NextRequest, NextResponse } from "next/server";
import { registerClient } from "@/lib/mcp/oauth";
import { getDb } from "@/lib/db";

/**
 * RFC 7591 动态客户端注册：连接器（ChatGPT / Claude Web 等）启动连接时自动注册。
 * 开放注册（client_id 非机密，PKCE 公共客户端）；真正的授权闸门是批准页人工批准 + 回跳地址精确匹配。
 */
const MAX_REDIRECT_URIS = 5;
const MAX_URI_LENGTH = 2000;

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URI_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 });
  }
  const metadata = (body ?? {}) as { client_name?: unknown; redirect_uris?: unknown };
  const clientName = typeof metadata.client_name === "string" ? metadata.client_name.trim() : "";
  const redirectUris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (!clientName) return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400 });
  if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS || !redirectUris.every(validRedirectUri)) {
    return NextResponse.json({ error: "invalid_redirect_uri" }, { status: 400 });
  }
  const db = getDb();
  const { clientId } = await registerClient({ execute: db.execute.bind(db) }, { clientName, redirectUris: redirectUris as string[] });
  return NextResponse.json(
    { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: clientName, redirect_uris: redirectUris },
    { status: 201 },
  );
}
