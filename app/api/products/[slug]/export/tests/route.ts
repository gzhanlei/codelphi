import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProductDetails } from "@/lib/product-details";
import { requireProductAccess } from "@/lib/product-access";
import { getSessionUser } from "@/lib/session";
import { resolvePublicDemoProduct } from "@/lib/public-demo";
import { toGherkin, toMarkdownChecklist } from "@/lib/scenario-export";
import { enforceExportRateLimit } from "@/lib/rate-limit";

const formats = z.enum(["gherkin", "markdown"]);

/** 测试清单导出：登录成员按工作区读取；公开 demo 产品允许匿名只读（与页面 demo 视图同权）。 */
export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  const limited = await enforceExportRateLimit(request, user?.sub ?? null, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = user ? await requireProductAccess(user, slug) : null;
  let organizationId: number;
  if (access) {
    organizationId = access.product.organizationId;
  } else {
    const demo = await resolvePublicDemoProduct(slug);
    if (!demo) return NextResponse.json({ error: user ? "产品不存在或不属于当前工作区" : "未登录" }, { status: user ? 404 : 401 });
    organizationId = demo.organizationId;
  }

  const format = formats.safeParse(request.nextUrl.searchParams.get("format") ?? "gherkin");
  if (!format.success) return NextResponse.json({ error: "format 仅支持 gherkin 或 markdown" }, { status: 400 });

  const details = await getProductDetails(slug, organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });

  const extension = format.data === "gherkin" ? "feature" : "md";
  const body = format.data === "gherkin"
    ? toGherkin(details.features, details.scenarios)
    : toMarkdownChecklist(details.features, details.scenarios);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-tests.${extension}"`,
    },
  });
}
