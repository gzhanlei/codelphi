import { apiErrorBody } from "@/lib/api-errors";
import { NextRequest, NextResponse } from "next/server";
import { updateProductDescription } from "@/lib/product-description";
import { updateProductIdentity } from "@/lib/product-rename";
import { requireOrganization } from "@/lib/organizations";
import { requireProductAccess } from "@/lib/product-access";
import { productUpdateSchema } from "@/lib/product-input";
import { productRemovalError, removeProduct } from "@/lib/product-removal";
import { requireSessionUser } from "@/lib/session";
import { MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE, ModelNotConfiguredError, switchAnalysisExecutor } from "@/lib/analysis-executor";

export const runtime = "nodejs";

const NOT_FOUND = apiErrorBody("product_not_found");

export async function PATCH(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug, "editor");
  if (!access) return NextResponse.json(NOT_FOUND, { status: 404 });
  const parsed = productUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "产品信息无效" }, { status: 400 });

  const { name, slug: newSlug, description, isPublicDemo, outputLanguage, analysisExecutor } = parsed.data;
  let currentSlug = slug;
  let currentName = access.product.name;
  if (name !== undefined || newSlug !== undefined || isPublicDemo !== undefined || outputLanguage !== undefined) {
    // 公开演示影响匿名可见性：仅工作区成员可切换，产品级 editor 不能把产品变公开。
    if (isPublicDemo !== undefined && access.via !== "organization") {
      return NextResponse.json({ error: "只有工作区成员可以修改公开演示设置" }, { status: 403 });
    }
    const renamed = await updateProductIdentity(slug, access.product.organizationId, { name, newSlug, isPublicDemo, outputLanguage });
    if (renamed.status === "not_found") return NextResponse.json(NOT_FOUND, { status: 404 });
    if (renamed.status === "slug_conflict") return NextResponse.json(apiErrorBody("slug_conflict"), { status: 409 });
    currentSlug = renamed.slug;
    currentName = renamed.name;
  }
  if (analysisExecutor !== undefined) {
    // 切到服务端分析时，工作区必须先有自己的模型（CoDelphi 不替用户付模型费用）。界面在没配模型时不给选，这里是绕过界面时也躲不过的那一道。
    try {
      await switchAnalysisExecutor(access.product.id, analysisExecutor);
    } catch (error) {
      if (!(error instanceof ModelNotConfiguredError)) throw error;
      return NextResponse.json({ error: error.code, message: MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE }, { status: 409 });
    }
  }
  if (description !== undefined) {
    const result = await updateProductDescription(currentSlug, access.product.organizationId, description.trim());
    if (!result) return NextResponse.json(NOT_FOUND, { status: 404 });
  }
  return NextResponse.json({ status: "updated", slug: currentSlug, name: currentName, organizationSlug: access.organization.slug });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  // 删除产品是工作区级破坏性操作，仅工作区 editor/owner 可执行；产品级成员不可删除。
  const user = await requireSessionUser();
  const organization = await requireOrganization(user, "editor");
  try {
    const { slug } = await context.params;
    await removeProduct(slug, organization.id);
    return NextResponse.json({ status: "deleted" });
  } catch (error) {
    const { status, message } = productRemovalError(error);
    return NextResponse.json({ error: message }, { status });
  }
}
