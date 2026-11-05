import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { requireProductAccess } from "@/lib/product-access";
import { getProductDetails } from "@/lib/product-details";
import { buildProductOverview } from "@/lib/product-overview";
import { exportProductExplainer } from "@/lib/explainer-export";
import { finalizeExplainer, ArchifyCommandError } from "@/lib/archify-cli";
import { safeArtifactAbsolutePath } from "@/lib/architecture-store";
import { artifactSandboxHeaders } from "@/lib/artifact-response";
import { errorMessage } from "@/lib/error-message";

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const { slug } = await context.params;
  const access = await requireProductAccess(user, slug);
  if (!access) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const details = await getProductDetails(slug, access.product.organizationId);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const overview = buildProductOverview(details);
  try {
    const { artifactPath } = await exportProductExplainer({ productSlug: slug, overview }, { finalize: finalizeExplainer });
    const html = await readFile(safeArtifactAbsolutePath(artifactPath, process.cwd()), "utf8");
    return new NextResponse(html, { status: 200, headers: artifactSandboxHeaders() });
  } catch (error) {
    const receipt = error instanceof ArchifyCommandError ? error.receipt : undefined;
    return NextResponse.json({ error: errorMessage(error, "Explainer 导出失败"), receipt }, { status: 500 });
  }
}
