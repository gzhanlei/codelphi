import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProductDetails } from "@/lib/product-details";
import { requireProductAccess } from "@/lib/product-access";
import { requireSessionUser } from "@/lib/session";
import { toGherkin, toMarkdownChecklist } from "@/lib/scenario-export";

const formats = z.enum(["gherkin", "markdown"]);

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在或不属于当前工作区" }, { status: 404 });

  const format = formats.safeParse(request.nextUrl.searchParams.get("format") ?? "gherkin");
  if (!format.success) return NextResponse.json({ error: "format 仅支持 gherkin 或 markdown" }, { status: 400 });

  const details = await getProductDetails(slug, access.product.organizationId);
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
