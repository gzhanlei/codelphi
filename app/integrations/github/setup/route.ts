import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { completeInstallationSetup } from "@/lib/github-onboarding";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function GET(request: NextRequest) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const error = await completeInstallationSetup(Number(request.nextUrl.searchParams.get("installation_id")), organization.id);
  return NextResponse.redirect(new URL(error ? `/integrations?error=${error}` : "/integrations?success=connected", appUrl()));
}
