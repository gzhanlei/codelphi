import { NextRequest, NextResponse } from "next/server";
import { createFeature, specEditorErrorInfo } from "@/lib/spec-editor-service";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { slug } = await context.params;
  try {
    const feature = await createFeature(slug, await request.json(), organization.id);
    return NextResponse.json(feature, { status: 201 });
  } catch (error) {
    const { status, message } = specEditorErrorInfo(error);
    return NextResponse.json({ error: message }, { status });
  }
}
