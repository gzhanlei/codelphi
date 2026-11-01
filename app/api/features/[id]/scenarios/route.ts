import { NextRequest } from "next/server";
import { createScenario } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  await requireSessionUser();
  const { id } = await context.params;
  return editorAction(async () => createScenario(routeEntityId(id), await request.json()), 201);
}
