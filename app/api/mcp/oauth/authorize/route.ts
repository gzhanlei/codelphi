import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { currentOrganization } from "@/lib/organizations";
import { getDb } from "@/lib/db";
import { resolveUserIdBySub } from "@/lib/mcp/oauth";

/**
 * A1 OAuth 批准页（GET 展示应用名与回跳地址；POST 批准并带授权码回跳）。
 * 只有登录用户可批准；批准主体 = 用户在当前工作区的身份。
 */
function esc(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const clientName = params.get("client_name") ?? "未知应用";
  const redirectUri = params.get("redirect_uri") ?? "";
  const state = params.get("state") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "S256";
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!redirectUri || !challenge || method !== "S256") return NextResponse.json({ error: "缺少 PKCE 参数" }, { status: 400 });
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>连接授权 · CoDelphi</title><style>body{font-family:system-ui;max-width:480px;margin:10vh auto;padding:0 16px}button{padding:8px 20px;margin-right:8px}.app{font-weight:600}.uri{color:#666;word-break:break-all;font-size:13px}</style></head><body>
<h1>授权连接</h1>
<p>应用 <span class="app">${esc(clientName)}</span> 请求以只读方式访问你的 CoDelphi 工作区（产品规格、发布与证据链接）。</p>
<p class="uri">回跳地址：${esc(redirectUri)}</p>
<p>授权后该应用 1 小时内有效；30 天未使用需要重新连接。可随时在工作区设置中撤销。</p>
<form method="post">
<input type="hidden" name="client_name" value="${esc(clientName)}">
<input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
<input type="hidden" name="code_challenge" value="${esc(challenge)}">
<input type="hidden" name="state" value="${esc(state)}">
<button type="submit" name="decision" value="approve">批准</button>
<button type="submit" name="decision" value="deny" formnovalidate>拒绝</button>
</form></body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const decision = String(form.get("decision") ?? "deny");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const clientName = String(form.get("client_name") ?? "未知应用");
  const codeChallenge = String(form.get("code_challenge") ?? "");
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!redirectUri || !codeChallenge) return NextResponse.json({ error: "缺少 PKCE 参数" }, { status: 400 });
  if (decision !== "approve") {
    return NextResponse.redirect(new URL(`${redirectUri}${redirectUri.includes("?") ? "&" : "?"}error=access_denied${state ? `&state=${encodeURIComponent(state)}` : ""}`, request.url));
  }
  const db = getDb();
  const execute = db.execute.bind(db) as unknown as (statement: string, parameters: Array<string | number | null>) => Promise<unknown>;
  const organization = await currentOrganization(user, undefined, execute);
  const userId = await resolveUserIdBySub(execute, user.sub);
  if (!organization || userId === null) return NextResponse.json({ error: "工作区解析失败" }, { status: 403 });
  const { approveGrant } = await import("@/lib/mcp/oauth");
  const grant = await approveGrant({ execute }, { organizationId: organization.id, userId, clientName, redirectUri, codeChallenge });
  return NextResponse.redirect(new URL(`${redirectUri}${redirectUri.includes("?") ? "&" : "?"}code=${grant.code}${state ? `&state=${encodeURIComponent(state)}` : ""}`, request.url));
}
