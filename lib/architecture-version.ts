import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ArchifyCommandError, deliverArchify, visualCheckArchify, type ArchifyReceipt, type DeliverArchifyInput } from "./archify-cli";
import { buildArchitectureDocument } from "./architecture-generic";
import { architectureDocumentSchema, type ArchitectureDocument } from "./architecture-draft";
import { architectureArtifactPath, architectureAnalysisPath, architectureFactsPath, architectureSpecPath, getProductIdentity, safeArtifactAbsolutePath, saveArchitectureDocument, type ArchitectureDocumentInput } from "./architecture-store";
import { errorMessage } from "./error-message";
import type { CodeHostingProvider, SourceFile } from "./code-hosting/types";
import { projectArchitectureDocument } from "./architecture/project";
import { analyzeRepositoryArchitecture, assertArchitecturePublishable } from "./architecture/repository";
import type { ArchitectureRepositorySourceReceipt } from "./architecture/remote";

export interface ArchitectureRun {
  productId: number;
  owner: string;
  name: string;
  afterSha: string;
  provider?: CodeHostingProvider;
}

interface ProductIdentity {
  id: number;
  slug: string;
  name: string;
}

interface GenerateArchitectureInput {
  run: ArchitectureRun;
  product?: ProductIdentity;
  sources: SourceFile[];
  specVersionId: number;
}

export interface GenerateRepositoryArchitectureInput extends GenerateArchitectureInput {
  sourceReceipt: ArchitectureRepositorySourceReceipt;
}

type RepositoryAnalysis = ReturnType<typeof analyzeRepositoryArchitecture>;
type ArchitectureBase = Omit<ArchitectureDocumentInput, "status" | "validationReceipt" | "visualReceipt" | "errorMessage">;

interface ArchitectureServices {
  root?: string;
  save: (input: ArchitectureDocumentInput) => Promise<void>;
  deliver: (input: DeliverArchifyInput) => Promise<ArchifyReceipt>;
  visualCheck: (input: { artifact: string }) => Promise<ArchifyReceipt>;
  repoRoot: (run: ArchitectureRun) => string | undefined;
}

const rootsSchema = z.record(z.string(), z.string());

export function localRepositoryRoot(run: ArchitectureRun, env: Record<string, string | undefined> = process.env) {
  const fullName = `${run.owner}/${run.name}`;
  const roots = rootsSchema.parse(JSON.parse(env.CODELPHI_REPOSITORY_ROOTS || "{}"));
  if (roots[fullName]) return roots[fullName];
  return env.GITHUB_REPOSITORY === fullName ? process.cwd() : undefined;
}

function defaultServices(): ArchitectureServices {
  return {
    save: saveArchitectureDocument,
    deliver: deliverArchify,
    visualCheck: visualCheckArchify,
    repoRoot: localRepositoryRoot,
  };
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

export function withoutRepositoryEvidence(document: ArchitectureDocument): ArchitectureDocument {
  const meta = { ...document.meta };
  delete meta.repository;
  return architectureDocumentSchema.parse({
    ...document,
    meta,
    components: document.components.map((component) => {
      const next = { ...component };
      delete next.sources;
      return next;
    }),
  });
}

function errorReceipt(error: unknown) {
  return error instanceof ArchifyCommandError ? error.receipt : undefined;
}

function writeRepositoryAnalysis(analysis: RepositoryAnalysis, product: ProductIdentity, specVersionId: number, root: string) {
  const factsRelative = architectureFactsPath(product.slug, specVersionId);
  const analysisRelative = architectureAnalysisPath(product.slug, specVersionId);
  const factsPath = safeArtifactAbsolutePath(factsRelative, root);
  const analysisPath = safeArtifactAbsolutePath(analysisRelative, root);
  const factsJson = `${JSON.stringify(analysis.facts, null, 2)}\n`;
  const analysisJson = `${JSON.stringify({ version: 1, revision: analysis.facts.revision, source: analysis.sourceReceipt, signals: analysis.inventory.signals, coverage: analysis.coverage }, null, 2)}\n`;
  mkdirSync(dirname(factsPath), { recursive: true });
  writeFileSync(factsPath, factsJson, { mode: 0o600 });
  writeFileSync(analysisPath, analysisJson, { mode: 0o600 });
  return {
    engine: "repository-facts-v1",
    source: analysis.sourceReceipt,
    coverage: analysis.coverage,
    artifacts: {
      facts: { path: factsRelative, sha256: sha256(factsJson) },
      analysis: { path: analysisRelative, sha256: sha256(analysisJson) },
    },
  };
}

async function prepareArchitecture(input: GenerateArchitectureInput, services: ArchitectureServices, repositoryEvidence: boolean, base: ArchitectureBase, analysis?: RepositoryAnalysis) {
  const product = input.product === undefined ? await getProductIdentity(input.run.productId) : input.product;
  if (!product) throw new Error("Product not found for architecture generation");
  base.productId = product.id;
  const specRelative = architectureSpecPath(product.slug, input.specVersionId);
  const artifactRelative = architectureArtifactPath(product.slug, input.specVersionId);
  if (services.root === "") throw new Error("Artifact root cannot be empty");
  const root = services.root === undefined ? process.cwd() : services.root;
  const specPath = safeArtifactAbsolutePath(specRelative, root);
  const artifactPath = safeArtifactAbsolutePath(artifactRelative, root);
  if (analysis) {
    base.analysisReceipt = writeRepositoryAnalysis(analysis, product, input.specVersionId, root);
    if (!analysis.coverage.publishable) return { base, specPath, artifactPath, artifactRelative, quality: "standard" as const };
  }
  const authored = analysis ? projectArchitectureDocument({
    productName: product.name,
    productSlug: product.slug,
    owner: input.run.owner,
    provider: input.run.provider,
    name: input.run.name,
    revision: input.run.afterSha,
  }, analysis.facts) : buildArchitectureDocument({
    productName: product.name,
    productSlug: product.slug,
    owner: input.run.owner,
    provider: input.run.provider,
    name: input.run.name,
    revision: input.run.afterSha,
    sources: input.sources,
  });
  const spec = repositoryEvidence ? authored : withoutRepositoryEvidence(authored);
  const specJson = `${JSON.stringify(spec, null, 2)}\n`;
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, specJson, { mode: 0o600 });
  base.specJson = specJson;
  base.specSha256 = sha256(specJson);
  return { base, specPath, artifactPath, artifactRelative, quality: spec.meta.quality_profile };
}

async function recordFailure(error: unknown, stage: "prepare" | "delivery" | "visual", base: { artifactSha256: string | null }, validationReceipt: unknown, visualReceipt: unknown, input: ArchitectureBase, save: ArchitectureServices["save"]) {
  const status = base.artifactSha256 ? "rendered" : "failed";
  const receipt = errorReceipt(error);
  const nextValidation = stage === "delivery" ? (receipt === undefined ? validationReceipt : receipt) : validationReceipt;
  const nextVisual = stage === "visual" ? (receipt === undefined ? visualReceipt : receipt) : visualReceipt;
  const result: ArchitectureDocumentInput = {
    ...input,
    status,
    validationReceipt: nextValidation,
    visualReceipt: nextVisual,
    errorMessage: errorMessage(error, "Architecture generation failed").slice(0, 8_000),
  };
  await save(result);
  return result;
}

async function generateArchitecture(input: GenerateArchitectureInput, services: ArchitectureServices, analysis?: RepositoryAnalysis | (() => RepositoryAnalysis)) {
  const base: ArchitectureBase = {
    productId: input.product ? input.product.id : input.run.productId,
    specVersionId: input.specVersionId,
    revision: input.run.afterSha,
    specJson: "",
    specSha256: sha256(""),
    artifactPath: null as string | null,
    artifactSha256: null as string | null,
    analysisReceipt: undefined as unknown,
  };
  let validationReceipt: unknown;
  let visualReceipt: unknown;
  let stage: "prepare" | "delivery" | "visual" = "prepare";

  try {
    const repoRoot = services.repoRoot(input.run);
    const resolvedAnalysis = typeof analysis === "function" ? analysis() : analysis;
    const prepared = await prepareArchitecture(input, services, repoRoot !== undefined, base, resolvedAnalysis);
    Object.assign(base, prepared.base);
    if (resolvedAnalysis) assertArchitecturePublishable(resolvedAnalysis.coverage);
    const { specPath, artifactPath, artifactRelative } = prepared;
    stage = "delivery";
    validationReceipt = await services.deliver({ type: "architecture", input: specPath, output: artifactPath, repoRoot, quality: prepared.quality });
    base.artifactPath = artifactRelative;
    base.artifactSha256 = sha256(readFileSync(artifactPath));
    stage = "visual";
    visualReceipt = await services.visualCheck({ artifact: artifactPath });
    const result: ArchitectureDocumentInput = { ...base, status: "accepted", validationReceipt, visualReceipt, errorMessage: null };
    await services.save(result);
    return result;
  } catch (error) {
    return recordFailure(error, stage, base, validationReceipt, visualReceipt, base, services.save);
  }
}

export function generateArchitectureVersion(input: GenerateArchitectureInput, services: ArchitectureServices = defaultServices()) {
  return generateArchitecture(input, services);
}

export function generateRepositoryArchitectureVersion(input: GenerateRepositoryArchitectureInput, services: ArchitectureServices = defaultServices()) {
  return generateArchitecture(input, services, () => analyzeRepositoryArchitecture({ revision: input.run.afterSha, sources: input.sources, sourceReceipt: input.sourceReceipt }));
}
