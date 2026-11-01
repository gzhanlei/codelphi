import { NextRequest, NextResponse } from "next/server";
import { appUrl, chandlerBaseUrl, requiredEnv } from "@/lib/env";
import { pkceChallenge, randomToken, safeNextPath } from "@/lib/oauth";

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
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600,
  };
  response.cookies.set("radar_oauth_state", state, cookieOptions);
  response.cookies.set("radar_oauth_verifier", verifier, cookieOptions);
  response.cookies.set("radar_oauth_next", safeNextPath(request.nextUrl.searchParams.get("next")), cookieOptions);
  return response;
}
