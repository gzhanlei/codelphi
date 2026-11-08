import { NextRequest, NextResponse } from "next/server";
import { assertChandlerAllowed, completeChandlerOAuth } from "@/lib/chandler";
import { storeChandlerTokens } from "@/lib/chandler-token";
import { allowedEmails, appUrl } from "@/lib/env";
import { oauthFailurePath, requireOAuthCallback } from "@/lib/oauth-request";
import { createSession } from "@/lib/session";
import { findUserIdBySub, upsertCodelphiUser } from "@/lib/users";

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

  await upsertCodelphiUser(authentication.profile);
  // Chandler token 加密落库（M3-T1）：支付 prepay/查单需要用户 token；失败不阻断登录（可重新登录补齐）
  try {
    const userId = await findUserIdBySub(authentication.profile.sub);
    if (userId !== null) await storeChandlerTokens(userId, authentication.tokens);
  } catch (error) {
    console.warn("[billing] chandler token store failed; payments may require re-login", error);
  }
  await createSession(authentication.profile);
  return redirectWithClearedOAuth(authentication.input.next);
}
