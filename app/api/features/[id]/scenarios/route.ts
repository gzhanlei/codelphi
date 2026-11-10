import { NextRequest, NextResponse } from "next/server";
import { createScenario } from "@/lib/spec-editor-service";
import { editorAction, routeEntityId } from "@/lib/editor-route";
import { requireSessionUser } from "@/lib/session";
import { requireFeatureProductAccess } from "@/lib/product-access";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireSessionUser();
  const { id } = await context.params;
  const access = await requireFeatureProductAccess(user, routeEntityId(id), "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  return editorAction(async () => createScenario(routeEntityId(id), await request.json(), access.product.organizationId, user.sub), 201);
}
