import { NextRequest, NextResponse } from "next/server";
import { deleteScenario, updateScenario } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";
import { requireScenarioProductAccess } from "@/lib/product-access";

const NOT_FOUND = { error: "产品不存在或不属于当前工作区" };

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const { id } = await context.params;
  const access = await requireScenarioProductAccess(user, routeEntityId(id), "editor");
  if (!access) return NextResponse.json(NOT_FOUND, { status: 404 });
  return editorAction(async () => updateScenario(routeEntityId(id), await request.json(), access.product.organizationId, user.sub));
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const { id } = await context.params;
  const access = await requireScenarioProductAccess(user, routeEntityId(id), "editor");
  if (!access) return NextResponse.json(NOT_FOUND, { status: 404 });
  return editorAction(() => deleteScenario(routeEntityId(id), access.product.organizationId, user.sub));
}
