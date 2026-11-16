import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getProductDetails } from "@/lib/product-details";
import { generateDomainCandidates } from "@/lib/business-domain-candidates";
import { errorMessage } from "@/lib/error-message";

/**
 * Task 0：AI 业务分组候选（只读生成面）。POST 生成候选并返回，不写数据库、
 * 不改变首页；只有维护者审核通过并运行迁移脚本后才会落地分组。
 */
export async function POST(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  if (access.role === "viewer") return NextResponse.json({ error: "无权限" }, { status: 403 });
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  try {
    const result = await generateDomainCandidates({
      name: details.product.name,
      description: details.product.description,
      features: details.features,
      scenarios: details.scenarios,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error, "候选生成失败") }, { status: 500 });
  }
}
