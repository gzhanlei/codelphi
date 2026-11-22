import { NextRequest, NextResponse } from "next/server";
import { assertChandlerAllowed, completeChandlerOAuth } from "@/lib/chandler";
import { establishCodelphiSession } from "@/lib/chandler-auth";
import { allowedEmails, appUrl } from "@/lib/env";
import { oauthFailurePath, requireOAuthCallback } from "@/lib/oauth-request";

function redirectWithClearedOAuth(path: string) {
  const response = NextResponse.redirect(new URL(path, appUrl()));
  for (const name of ["codelphi_oauth_state", "codelphi_oauth_verifier", "codelphi_oauth_next"]) {
    response.cookies.delete(name);
  }
  return response;
}

function oauthCookie(request: NextRequest, name: string) {
  return request.cookies.get(name)?.value;
}

async function authenticate(request: NextRequest) {
  const input = requireOAuthCallback({
    code: request.nextUrl.searchParams.get("code"),
    state: request.nextUrl.searchParams.get("state"),
    expectedState: oauthCookie(request, "codelphi_oauth_state"),
    verifier: oauthCookie(request, "codelphi_oauth_verifier"),
    next: oauthCookie(request, "codelphi_oauth_next"),
  });
  const { profile, tokens } = await completeChandlerOAuth({ code: input.code, verifier: input.verifier, redirectUri: `${appUrl()}/auth/callback` });
  assertChandlerAllowed(profile.email, allowedEmails());
  return { input, profile, tokens };
}

export async function GET(request: NextRequest) {
  let authentication;
  try {
    authentication = await authenticate(request);
  } catch (error) {
    return redirectWithClearedOAuth(oauthFailurePath(error));
  }

  // 与密码注册/登录共用同一会话落地面（lib/chandler-auth.ts establishCodelphiSession）
  await establishCodelphiSession(authentication.profile, authentication.tokens);
  return redirectWithClearedOAuth(authentication.input.next);
}
