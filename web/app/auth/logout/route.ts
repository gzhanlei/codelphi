import { NextResponse } from "next/server";
import { appURL } from "@/lib/oidc";
import { COOKIE_AT, COOKIE_ORG, COOKIE_PKCE, COOKIE_RT, COOKIE_STATE, cookieOpts } from "@/lib/session";

export function GET() {
  const res = NextResponse.redirect(new URL("/login", appURL()));
  for (const name of [COOKIE_AT, COOKIE_RT, COOKIE_ORG, COOKIE_PKCE, COOKIE_STATE]) {
    res.cookies.set(name, "", { ...cookieOpts(0), maxAge: 0 });
  }
  return res;
}
