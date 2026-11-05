import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { type ArchifyReceipt } from "./archify-cli";
import { explainerArtifactPath, explainerSpecPath, safeArtifactAbsolutePath } from "./architecture-store";
import { buildExplainerMarkdown } from "./product-explainer";
import type { ProductOverviewData } from "./product-overview";

interface ExplainerExportInput {
  productSlug: string;
  overview: ProductOverviewData;
}

interface ExplainerServices {
  root?: string;
  finalize: (input: { input: string; output: string; browserCheck: boolean; outDir?: string }) => Promise<ArchifyReceipt>;
}

function explainerReceiptDirectory(productSlug: string, specVersionId: number, markdown: string, root: string) {
  const digest = createHash("sha256").update(markdown).digest("hex");
  return safeArtifactAbsolutePath(`artifacts/products/${productSlug}/${specVersionId}/receipts/${digest}`, root);
}

export async function exportProductExplainer(input: ExplainerExportInput, services: ExplainerServices) {
  const specVersionId = input.overview.trust.specVersionId;
  if (specVersionId === null) throw new Error("Spec version is required for Explainer export");
  const markdown = buildExplainerMarkdown(input.overview);
  const specRelative = explainerSpecPath(input.productSlug, specVersionId);
  const artifactRelative = explainerArtifactPath(input.productSlug, specVersionId);
  const root = services.root === undefined ? process.cwd() : services.root;
  const specPath = safeArtifactAbsolutePath(specRelative, root);
  const artifactPath = safeArtifactAbsolutePath(artifactRelative, root);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, markdown, { mode: 0o600 });
  const receipt = await services.finalize({ input: specPath, output: artifactPath, browserCheck: true, outDir: explainerReceiptDirectory(input.productSlug, specVersionId, markdown, root) });
  return { specPath: specRelative, artifactPath: artifactRelative, receipt };
}
