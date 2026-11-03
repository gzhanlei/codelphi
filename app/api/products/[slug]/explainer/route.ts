import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/session";
import { requireOrganization } from "@/lib/organizations";
import { getProductDetails } from "@/lib/product-details";
import { buildProductOverview } from "@/lib/product-overview";
import { exportProductExplainer } from "@/lib/explainer-export";
import { finalizeExplainer, ArchifyCommandError } from "@/lib/archify-cli";
import { localRepositoryRoot } from "@/lib/architecture-version";
import { safeArtifactAbsolutePath } from "@/lib/architecture-store";
import { artifactSandboxHeaders } from "@/lib/artifact-response";
import { errorMessage } from "@/lib/error-message";

export async function GET(_request: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const user = await requireSessionUser();
  const organization = await requireOrganization(user);
  const { slug } = await context.params;
  const details = await getProductDetails(slug, organization.id);
  if (!details) return NextResponse.json({ error: "产品不存在" }, { status: 404 });
  const overview = buildProductOverview(details);
  try {
    const repository = details.repository;
    const repoRoot = repository ? localRepositoryRoot({ productId: details.product.id, owner: repository.owner, name: repository.name, afterSha: overview.architecture?.revision ?? "" }) : undefined;
    const { artifactPath } = await exportProductExplainer({ productSlug: slug, overview, architecture: details.architecture, repoRoot }, { finalize: finalizeExplainer });
    const html = await readFile(safeArtifactAbsolutePath(artifactPath, process.cwd()), "utf8");
    return new NextResponse(html, { status: 200, headers: artifactSandboxHeaders() });
  } catch (error) {
    const receipt = error instanceof ArchifyCommandError ? error.receipt : undefined;
    return NextResponse.json({ error: errorMessage(error, "Explainer 导出失败"), receipt }, { status: 500 });
  }
}
