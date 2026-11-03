import { NextRequest } from "next/server";
import { deleteFeature, updateFeature } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { id } = await context.params;
  return editorAction(async () => updateFeature(routeEntityId(id), await request.json(), organization.id));
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { id } = await context.params;
  return editorAction(() => deleteFeature(routeEntityId(id), organization.id));
}
