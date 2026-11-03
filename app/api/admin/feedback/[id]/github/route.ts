import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";
import { requirePlatformAdmin } from "@/lib/platform-admin";
import { submitFeedbackToGitHub } from "@/lib/feedback";
import { routeEntityId } from "@/lib/editor-route";

export async function POST(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  await requirePlatformAdmin(user, organization);
  const { id } = await context.params;
  try {
    const issueUrl = await submitFeedbackToGitHub(routeEntityId(id));
    return NextResponse.json({ issueUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "github_issue_failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
