import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ArchifyCommandError, deliverArchify, visualCheckArchify, type ArchifyReceipt, type DeliverArchifyInput } from "./archify-cli";
import { buildArchitectureDocument } from "./architecture-generic";
import { architectureArtifactPath, architectureSpecPath, getProductIdentity, safeArtifactAbsolutePath, saveArchitectureDocument, type ArchitectureDocumentInput } from "./architecture-store";
import { errorMessage } from "./error-message";
import type { CodeHostingProvider, SourceFile } from "./code-hosting/types";

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
  const roots = rootsSchema.parse(JSON.parse(env.RADAR_REPOSITORY_ROOTS || "{}"));
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

function errorReceipt(error: unknown) {
  return error instanceof ArchifyCommandError ? error.receipt : undefined;
}

async function prepareArchitecture(input: GenerateArchitectureInput, services: ArchitectureServices) {
  const product = input.product === undefined ? await getProductIdentity(input.run.productId) : input.product;
  if (!product) throw new Error("Product not found for architecture generation");
  const spec = buildArchitectureDocument({
    productName: product.name,
    productSlug: product.slug,
    owner: input.run.owner,
    provider: input.run.provider ?? "github",
    name: input.run.name,
    revision: input.run.afterSha,
    sources: input.sources,
  });
  const specJson = `${JSON.stringify(spec, null, 2)}\n`;
  const specRelative = architectureSpecPath(product.slug, input.specVersionId);
  const artifactRelative = architectureArtifactPath(product.slug, input.specVersionId);
  if (services.root === "") throw new Error("Artifact root cannot be empty");
  const root = services.root === undefined ? process.cwd() : services.root;
  const specPath = safeArtifactAbsolutePath(specRelative, root);
  const artifactPath = safeArtifactAbsolutePath(artifactRelative, root);
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, specJson, { mode: 0o600 });
  const base = {
    productId: product.id,
    specVersionId: input.specVersionId,
    revision: input.run.afterSha,
    specJson,
    specSha256: sha256(specJson),
    artifactPath: null as string | null,
    artifactSha256: null as string | null,
  };
  return { base, specPath, artifactPath, artifactRelative };
}

async function recordFailure(error: unknown, stage: "prepare" | "delivery" | "visual", base: { artifactSha256: string | null }, validationReceipt: unknown, visualReceipt: unknown, input: Omit<ArchitectureDocumentInput, "status" | "validationReceipt" | "visualReceipt" | "errorMessage">, save: ArchitectureServices["save"]) {
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

export async function generateArchitectureVersion(input: GenerateArchitectureInput, services: ArchitectureServices = defaultServices()) {
  const base = {
    productId: input.product ? input.product.id : input.run.productId,
    specVersionId: input.specVersionId,
    revision: input.run.afterSha,
    specJson: "",
    specSha256: sha256(""),
    artifactPath: null as string | null,
    artifactSha256: null as string | null,
  };
  let validationReceipt: unknown;
  let visualReceipt: unknown;
  let stage: "prepare" | "delivery" | "visual" = "prepare";

  try {
    const prepared = await prepareArchitecture(input, services);
    Object.assign(base, prepared.base);
    const { specPath, artifactPath, artifactRelative } = prepared;
    stage = "delivery";
    const repoRoot = services.repoRoot(input.run);
    if (!repoRoot) throw new Error(`No matching local checkout for ${input.run.owner}/${input.run.name}`);
    validationReceipt = await services.deliver({ type: "architecture", input: specPath, output: artifactPath, repoRoot });
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
