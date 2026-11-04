import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { finalizeExplainer, type ArchifyReceipt } from "./archify-cli";
import { architectureDocumentSchema } from "./architecture-draft";
import { explainerArtifactPath, explainerSpecPath, safeArtifactAbsolutePath, type ArchitectureDocumentRecord } from "./architecture-store";
import { buildExplainerMarkdown } from "./product-explainer";
import type { ProductOverviewData } from "./product-overview";

interface ExplainerExportInput {
  productSlug: string;
  overview: ProductOverviewData;
  architecture?: ArchitectureDocumentRecord;
  repoRoot?: string;
}

interface ExplainerServices {
  root?: string;
  finalize: (input: { input: string; output: string; repoRoot?: string; browserCheck: boolean; outDir?: string }) => Promise<ArchifyReceipt>;
}

function shouldIncludeArchitecture(input: ExplainerExportInput) {
  return input.overview.architecture?.status === "accepted" && input.architecture?.status === "accepted";
}

function architectureRepository(architecture: ArchitectureDocumentRecord) {
  return architectureDocumentSchema.parse(JSON.parse(architecture.specJson)).meta.repository?.url;
}

function evidenceRepositoryRoot(repositoryUrl: string | undefined, repoRoot: string | undefined) {
  return repositoryUrl ? repoRoot : undefined;
}

function writeArchitectureSpec(root: string, input: ExplainerExportInput, includeArchitecture: boolean, specVersionId: number) {
  if (!includeArchitecture || !input.architecture) return;
  const path = safeArtifactAbsolutePath(`artifacts/products/${input.productSlug}/${specVersionId}/architecture.json`, root);
  writeFileSync(path, input.architecture.specJson, { mode: 0o600 });
}

function explainerReceiptDirectory(productSlug: string, specVersionId: number, markdown: string, root: string) {
  const digest = createHash("sha256").update(markdown).digest("hex");
  return safeArtifactAbsolutePath(`artifacts/products/${productSlug}/${specVersionId}/receipts/${digest}`, root);
}

export async function exportProductExplainer(input: ExplainerExportInput, services: ExplainerServices) {
  const specVersionId = input.overview.trust.specVersionId;
  if (specVersionId === null) throw new Error("Spec version is required for Explainer export");
  if (input.overview.architecture && input.architecture && input.architecture.specVersionId !== specVersionId) throw new Error("Architecture version mismatch");

  const includeArchitecture = shouldIncludeArchitecture(input);
  const repositoryUrl = includeArchitecture && input.architecture ? architectureRepository(input.architecture) : undefined;
  const markdown = buildExplainerMarkdown(input.overview, { includeArchitecture, repositoryUrl });
  const specRelative = explainerSpecPath(input.productSlug, specVersionId);
  const artifactRelative = explainerArtifactPath(input.productSlug, specVersionId);
  const root = services.root === undefined ? process.cwd() : services.root;
  const specPath = safeArtifactAbsolutePath(specRelative, root);
  const artifactPath = safeArtifactAbsolutePath(artifactRelative, root);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, markdown, { mode: 0o600 });
  writeArchitectureSpec(root, input, includeArchitecture, specVersionId);
  const receipt = await services.finalize({ input: specPath, output: artifactPath, repoRoot: evidenceRepositoryRoot(repositoryUrl, input.repoRoot), browserCheck: true, outDir: explainerReceiptDirectory(input.productSlug, specVersionId, markdown, root) });
  return { specPath: specRelative, artifactPath: artifactRelative, receipt };
}
