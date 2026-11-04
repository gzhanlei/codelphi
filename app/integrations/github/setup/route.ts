import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { completeInstallationSetup } from "@/lib/github-onboarding";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";
import { requiredEnv } from "@/lib/env";

export async function GET(request: NextRequest) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const error = await completeInstallationSetup(
    Number(request.nextUrl.searchParams.get("installation_id")),
    organization.id,
    undefined,
    {
      value: request.nextUrl.searchParams.get("state"),
      expectedValue: request.cookies.get("github_installation_state")?.value,
      secret: requiredEnv("SESSION_SECRET"),
    },
  );
  const response = NextResponse.redirect(new URL(error ? `/integrations?error=${error}` : "/integrations?success=connected", appUrl()));
  response.cookies.set({ name: "github_installation_state", value: "", path: "/integrations/github/setup", maxAge: 0, httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" });
  return response;
}
