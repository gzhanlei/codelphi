import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, refreshAccessToken } from "@/lib/mcp/oauth";
import { getDb } from "@/lib/db";

/**
 * A1 OAuth token 端点：授权码 + code_verifier（PKCE S256）或 refresh_token 换访问 token。
 * 表单编码入参；access 1 小时过期；码一次性（交换后即失效）；refresh 30 天旋转。
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const grantType = String(form.get("grant_type") ?? "");
  const clientId = String(form.get("client_id") ?? "");
  if (!clientId) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const db = getDb();
  const executor = { execute: db.execute.bind(db) };
  if (grantType === "authorization_code") {
    const code = String(form.get("code") ?? "");
    const codeVerifier = String(form.get("code_verifier") ?? "");
    const redirectUri = String(form.get("redirect_uri") ?? "");
    if (!code || !codeVerifier || !redirectUri) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const token = await exchangeCodeForToken(executor, { code, codeVerifier, redirectUri, clientId });
    if (!token) {
      return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
    }
    return NextResponse.json({
      access_token: token.accessToken,
      token_type: "Bearer",
      expires_in: token.expiresIn,
      refresh_token: token.refreshToken,
    });
  }
  if (grantType === "refresh_token") {
    const refreshToken = String(form.get("refresh_token") ?? "");
    if (!refreshToken) return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    const token = await refreshAccessToken(executor, { refreshToken, clientId });
    if (!token) {
      return NextResponse.json({ error: "invalid_grant" }, { status: 400 });
    }
    return NextResponse.json({
      access_token: token.accessToken,
      token_type: "Bearer",
      expires_in: token.expiresIn,
      refresh_token: token.refreshToken,
    });
  }
  return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
}
