import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { allowedEmails, appUrl, chandlerBaseUrl, requiredEnv } from "@/lib/env";
import { safeNextPath } from "@/lib/oauth";
import { createSession } from "@/lib/session";

const tokenSchema = z.object({ access_token: z.string().min(1) });
const userInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().max(320).optional().nullable(),
  name: z.string().optional().nullable(),
  picture: z.string().optional().nullable(),
});

function unwrap(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "data" in value) {
    return (value as { data: unknown }).data;
  }
  return value;
}

function clearOAuthCookies(response: NextResponse) {
  for (const name of ["radar_oauth_state", "radar_oauth_verifier", "radar_oauth_next"]) {
    response.cookies.delete(name);
  }
  return response;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const expectedState = request.cookies.get("radar_oauth_state")?.value;
  const verifier = request.cookies.get("radar_oauth_verifier")?.value;
  const next = safeNextPath(request.cookies.get("radar_oauth_next")?.value ?? null);

  if (!code || !state || !expectedState || state !== expectedState || !verifier) {
    return clearOAuthCookies(NextResponse.redirect(new URL("/login?error=invalid_oauth_state", appUrl())));
  }

  const redirectUri = `${appUrl()}/auth/callback`;
  const tokenResponse = await fetch(`${chandlerBaseUrl()}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: requiredEnv("CHANDLER_CLIENT_ID"),
      client_secret: requiredEnv("CHANDLER_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenResponse.ok) {
    return clearOAuthCookies(NextResponse.redirect(new URL("/login?error=token_exchange_failed", appUrl())));
  }

  const token = tokenSchema.parse(unwrap(await tokenResponse.json()));
  const userInfoResponse = await fetch(`${chandlerBaseUrl()}/v1/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!userInfoResponse.ok) {
    return clearOAuthCookies(NextResponse.redirect(new URL("/login?error=userinfo_failed", appUrl())));
  }

  const profile = userInfoSchema.parse(unwrap(await userInfoResponse.json()));
  const allowlist = allowedEmails();
  const email = profile.email?.trim() ? profile.email.trim().toLowerCase() : undefined;
  const isAllowed = allowlist.size === 0
    ? process.env.NODE_ENV !== "production"
    : Boolean(email && allowlist.has(email));
  if (!isAllowed) {
    return clearOAuthCookies(NextResponse.redirect(new URL("/forbidden", appUrl())));
  }

  await getDb().execute(
    `INSERT INTO users (chandler_sub, email, display_name, picture_url)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       email = VALUES(email),
       display_name = VALUES(display_name),
       picture_url = VALUES(picture_url),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [profile.sub, email ?? null, profile.name ?? null, profile.picture ?? null],
  );

  const response = NextResponse.redirect(new URL(next, appUrl()));
  response.cookies.delete("radar_oauth_state");
  response.cookies.delete("radar_oauth_verifier");
  response.cookies.delete("radar_oauth_next");
  await createSession({
    sub: profile.sub,
    email,
    name: profile.name ?? undefined,
    picture: profile.picture ?? undefined,
  });
  return response;
}
