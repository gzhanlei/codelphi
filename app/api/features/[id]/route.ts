import { NextRequest } from "next/server";
import { deleteFeature, updateFeature } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  return editorAction(async () => updateFeature(routeEntityId(id), await request.json()));
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  return editorAction(() => deleteFeature(routeEntityId(id)));
}
