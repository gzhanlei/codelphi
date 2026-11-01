import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { getLatestGitHubApp } from "@/lib/github-integrations";
import { requireSessionUser } from "@/lib/session";

export async function GET() {
  await requireSessionUser();
  const app = await getLatestGitHubApp();
  if (!app) return NextResponse.redirect(new URL("/integrations?error=app_missing", appUrl()));
  return NextResponse.redirect(`https://github.com/apps/${app.slug}/installations/new`);
}
