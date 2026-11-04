import { NextResponse } from "next/server";
import { appUrl } from "@/lib/env";
import { radarManifest } from "@/lib/github-app";
import { manifestDocument } from "@/lib/github-manifest";
import { randomToken } from "@/lib/oauth";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function GET() {
  const user = await requireSessionUser();
  await requireOrganization(user, "editor");
  const state = randomToken();
  const response = new NextResponse(manifestDocument(radarManifest(appUrl()), state), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
  response.cookies.set("github_manifest_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return response;
}
