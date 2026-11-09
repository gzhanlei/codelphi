import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken } from "@/lib/mcp/oauth";
import { getDb } from "@/lib/db";

/**
 * A1 OAuth token 端点：授权码 + code_verifier（PKCE S256）换访问 token。
 * 表单编码入参；token 1 小时过期；码一次性（交换后即失效）。
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const grantType = String(form.get("grant_type") ?? "");
  const code = String(form.get("code") ?? "");
  const codeVerifier = String(form.get("code_verifier") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  if (grantType !== "authorization_code") {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  if (!code || !codeVerifier || !redirectUri) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const db = getDb();
  const token = await exchangeCodeForToken({ execute: db.execute.bind(db) }, { code, codeVerifier, redirectUri });
  if (!token) {
    return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
  }
  return NextResponse.json({
    access_token: token.plaintext,
    token_type: "Bearer",
    expires_in: 3600,
  });
}
