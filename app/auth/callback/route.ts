import { NextRequest, NextResponse } from "next/server";
import { assertChandlerAllowed, completeChandlerOAuth } from "@/lib/chandler";
import { allowedEmails, appUrl } from "@/lib/env";
import { oauthFailurePath, requireOAuthCallback } from "@/lib/oauth-request";
import { createSession } from "@/lib/session";
import { upsertRadarUser } from "@/lib/users";

function redirectWithClearedOAuth(path: string) {
  const response = NextResponse.redirect(new URL(path, appUrl()));
  for (const name of ["radar_oauth_state", "radar_oauth_verifier", "radar_oauth_next"]) {
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
    expectedState: oauthCookie(request, "radar_oauth_state"),
    verifier: oauthCookie(request, "radar_oauth_verifier"),
    next: oauthCookie(request, "radar_oauth_next"),
  });
  const profile = await completeChandlerOAuth({ code: input.code, verifier: input.verifier, redirectUri: `${appUrl()}/auth/callback` });
  assertChandlerAllowed(profile.email, allowedEmails());
  return { input, profile };
}

export async function GET(request: NextRequest) {
  let authentication;
  try {
    authentication = await authenticate(request);
  } catch (error) {
    return redirectWithClearedOAuth(oauthFailurePath(error));
  }

  await upsertRadarUser(authentication.profile);
  await createSession(authentication.profile);
  return redirectWithClearedOAuth(authentication.input.next);
}
