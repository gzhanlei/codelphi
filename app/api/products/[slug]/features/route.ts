import { NextRequest, NextResponse } from "next/server";
import { createFeature, specEditorErrorInfo } from "@/lib/spec-editor-service";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";

export async function POST(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });
  try {
    const feature = await createFeature(slug, await request.json(), access.product.organizationId);
    return NextResponse.json(feature, { status: 201 });
  } catch (error) {
    const { status, message } = specEditorErrorInfo(error);
    return NextResponse.json({ error: message }, { status });
  }
}
