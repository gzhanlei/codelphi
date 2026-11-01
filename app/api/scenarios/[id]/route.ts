import { NextRequest } from "next/server";
import { deleteScenario, updateScenario } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  return editorAction(async () => updateScenario(routeEntityId(id), await request.json()));
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  return editorAction(() => deleteScenario(routeEntityId(id)));
}
