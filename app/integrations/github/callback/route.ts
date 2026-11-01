import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { completeManifest } from "@/lib/github-onboarding";
import { manifestCallbackPath } from "@/lib/integration-ui";
import { requireSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  await requireSessionUser();
  const error = await completeManifest(
    request.nextUrl.searchParams.get("code"),
    request.nextUrl.searchParams.get("state"),
    request.cookies.get("github_manifest_state")?.value,
  );
  const response = NextResponse.redirect(new URL(manifestCallbackPath(error), appUrl()));
  response.cookies.delete("github_manifest_state");
  return response;
}
