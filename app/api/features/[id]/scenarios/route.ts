import { NextRequest } from "next/server";
import { createScenario } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  const { id } = await context.params;
  return editorAction(async () => createScenario(routeEntityId(id), await request.json(), organization.id), 201);
}
