import { NextRequest, NextResponse } from "next/server";
import { appURL, exchangeCode } from "@/lib/oidc";
import { COOKIE_AT, COOKIE_PKCE, COOKIE_RT, COOKIE_STATE, cookieOpts } from "@/lib/session";

export async function GET(req: NextRequest) {
  const origin = appURL();
  const err = req.nextUrl.searchParams.get("error");
  if (err) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(err)}`, origin));
  }
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectState = req.cookies.get(COOKIE_STATE)?.value;
  const verifier = req.cookies.get(COOKIE_PKCE)?.value;
  if (!code || !state || !expectState || state !== expectState || !verifier) {
    return NextResponse.redirect(new URL("/login?error=invalid_state", origin));
  }
  try {
    const tokens = await exchangeCode(code, verifier);
    const res = NextResponse.redirect(new URL("/", origin));
    res.cookies.set(COOKIE_AT, tokens.access_token, cookieOpts(tokens.expires_in || 3600));
    if (tokens.refresh_token) {
      res.cookies.set(COOKIE_RT, tokens.refresh_token, cookieOpts(60 * 60 * 24 * 30));
    }
    res.cookies.delete(COOKIE_PKCE);
    res.cookies.delete(COOKIE_STATE);
    return res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "token";
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, origin));
  }
}
