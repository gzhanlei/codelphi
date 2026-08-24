import { NextResponse } from "next/server";
import { authorizeURL, newPKCE } from "@/lib/oidc";
import { COOKIE_PKCE, COOKIE_STATE, cookieOpts } from "@/lib/session";

export async function GET() {
  const { verifier, challenge, state } = newPKCE();
  const res = NextResponse.redirect(authorizeURL(challenge, state));
  res.cookies.set(COOKIE_PKCE, verifier, cookieOpts(600));
  res.cookies.set(COOKIE_STATE, state, cookieOpts(600));
  return res;
}
