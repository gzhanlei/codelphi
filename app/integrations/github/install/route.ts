import { NextResponse } from "next/server";
import { appUrl, requiredEnv } from "@/lib/env";
import { getLatestGitHubApp } from "@/lib/github-integrations";
import { createGitHubInstallationState } from "@/lib/github-installation-state";
import { requireSessionUser, secureCookieOptions } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function GET() {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const app = await getLatestGitHubApp();
  if (!app) return NextResponse.redirect(new URL("/integrations?error=app_missing", appUrl()));
  const state = await createGitHubInstallationState(organization.id, app.id, requiredEnv("SESSION_SECRET"));
  const installationUrl = new URL(`https://github.com/apps/${app.slug}/installations/new`);
  installationUrl.searchParams.set("state", state);
  const response = NextResponse.redirect(installationUrl);
  response.cookies.set("github_installation_state", state, secureCookieOptions(600, "/integrations/github/setup"));
  return response;
}
