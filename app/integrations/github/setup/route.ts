import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { completeInstallationSetup } from "@/lib/github-onboarding";
import { requireSessionUser } from "@/lib/session";

export async function GET(request: NextRequest) {
  await requireSessionUser();
  const error = await completeInstallationSetup(Number(request.nextUrl.searchParams.get("installation_id")));
  return NextResponse.redirect(new URL(error ? `/integrations?error=${error}` : "/integrations?success=connected", appUrl()));
}
