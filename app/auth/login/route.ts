import { NextRequest, NextResponse } from "next/server";
import { appUrl, chandlerBaseUrl, requiredEnv } from "@/lib/env";
import { pkceChallenge, randomToken, safeNextPath } from "@/lib/oauth";
import { secureCookieOptions } from "@/lib/session";

export async function GET(request: NextRequest) {
  const state = randomToken();
  const verifier = randomToken(48);
  const redirectUri = `${appUrl()}/auth/callback`;
  const authorizationUrl = new URL(`${chandlerBaseUrl()}/v1/oauth/authorize`);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", requiredEnv("CHANDLER_CLIENT_ID"));
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", "openid profile email");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  const response = NextResponse.redirect(authorizationUrl);
  const cookieOptions = secureCookieOptions(600);
  response.cookies.set("codelphi_oauth_state", state, cookieOptions);
  response.cookies.set("codelphi_oauth_verifier", verifier, cookieOptions);
  response.cookies.set("codelphi_oauth_next", safeNextPath(request.nextUrl.searchParams.get("next")), cookieOptions);
  return response;
}
