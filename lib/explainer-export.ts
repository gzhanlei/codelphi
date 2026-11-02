import { dirname } from "node:path";
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
  finalize: (input: { input: string; output: string; repoRoot?: string; browserCheck: boolean }) => Promise<ArchifyReceipt>;
}

function shouldIncludeArchitecture(input: ExplainerExportInput) {
  return input.overview.architecture?.status === "accepted" && input.architecture?.status === "accepted";
}

function architectureRepository(architecture: ArchitectureDocumentRecord) {
  return architectureDocumentSchema.parse(JSON.parse(architecture.specJson)).meta.repository.url;
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
  if (includeArchitecture && input.architecture) writeFileSync(safeArtifactAbsolutePath(`artifacts/products/${input.productSlug}/${specVersionId}/architecture.json`, root), input.architecture.specJson, { mode: 0o600 });
  const receipt = await services.finalize({ input: specPath, output: artifactPath, repoRoot: includeArchitecture ? input.repoRoot : undefined, browserCheck: true });
  return { specPath: specRelative, artifactPath: artifactRelative, receipt };
}
