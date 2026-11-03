import { NextRequest } from "next/server";
import { deleteScenario, updateScenario } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { id } = await context.params;
  return editorAction(async () => updateScenario(routeEntityId(id), await request.json(), organization.id));
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { id } = await context.params;
  return editorAction(() => deleteScenario(routeEntityId(id), organization.id));
}
