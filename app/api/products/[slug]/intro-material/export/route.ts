import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getDb } from "@/lib/db";
import { getProductDetails } from "@/lib/product-details";
import { renderIntroMaterialHtml, renderIntroMaterialMarkdown, toConfirmedOutline } from "@/lib/intro-material";
import { loadIntroMaterial } from "@/lib/intro-material-service";
import { enforceExportRateLimit } from "@/lib/rate-limit";
import { artifactSandboxHeaders } from "@/lib/artifact-response";

/** 介绍材料导出（GTM 桥面批次 2）：markdown 大纲 / html 单页 / PPTCreator confirmed_outline JSON。 */
const formatSchema = z.enum(["markdown", "html", "outline-json"]);

export async function GET(request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const limited = await enforceExportRateLimit(request, user.sub, { anonymous: 10, user: 60 });
  if (limited) return limited;
  const access = await requireProductAccess(user, slug, "viewer");
  if (!access) return NextResponse.json({ error: "产品不存在或无访问权限" }, { status: 404 });
  const parsed = formatSchema.safeParse(new URL(request.url).searchParams.get("format") ?? "markdown");
  if (!parsed.success) return NextResponse.json({ error: "format 仅支持 markdown | html | outline-json" }, { status: 400 });
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const specVersionId = details.releases[0]?.specVersionId ?? null;
  const material = await loadIntroMaterial(getDb().execute.bind(getDb()), access.product.id, specVersionId);
  if (!material) return NextResponse.json({ error: "请先生成介绍材料大纲" }, { status: 404 });
  const coverageNote = details.coverage ? `证据覆盖率 ${(details.coverage.coverageRatio * 100).toFixed(1)}%（装配 ${details.coverage.implFilesAssembled}/${details.coverage.implFilesTotal} 个实现文件）` : null;

  if (parsed.data === "html") {
    return new NextResponse(renderIntroMaterialHtml({ productName: details.product.name, draft: material.draft, coverageNote }), {
      headers: artifactSandboxHeaders(),
    });
  }
  if (parsed.data === "outline-json") {
    return new NextResponse(JSON.stringify({ title: `${details.product.name} 介绍`, slides: toConfirmedOutline(material.draft) }, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${slug}-intro-outline.json"`,
      },
    });
  }
  return new NextResponse(renderIntroMaterialMarkdown({ productName: details.product.name, draft: material.draft, coverageNote }), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${slug}-intro-outline.md"`,
    },
  });
}
