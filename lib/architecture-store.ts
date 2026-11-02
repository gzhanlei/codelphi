import { resolve, sep } from "node:path";
import { z } from "zod";
import { getDb } from "./db";
import { parseJsonValue } from "./json";

const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type ArchitectureStatus = "rendered" | "accepted" | "failed";

export interface ArchitectureDocumentInput {
  productId: number;
  specVersionId: number;
  revision: string;
  status: ArchitectureStatus;
  specJson: string;
  specSha256: string;
  artifactPath: string | null;
  artifactSha256: string | null;
  validationReceipt: unknown;
  visualReceipt: unknown;
  errorMessage: string | null;
}

export interface ArchitectureDocumentRecord extends ArchitectureDocumentInput {
  id?: number;
  productSlug: string;
  productName: string;
}

export function architectureSpecPath(productSlug: string, specVersionId: number) {
  return `artifacts/products/${slugSchema.parse(productSlug)}/${specVersionId}/architecture.json`;
}

export function architectureArtifactPath(productSlug: string, specVersionId: number) {
  return `artifacts/products/${slugSchema.parse(productSlug)}/${specVersionId}/architecture.html`;
}

export function explainerSpecPath(productSlug: string, specVersionId: number) {
  return `artifacts/products/${slugSchema.parse(productSlug)}/${specVersionId}/explainer.md`;
}

export function explainerArtifactPath(productSlug: string, specVersionId: number) {
  return `artifacts/products/${slugSchema.parse(productSlug)}/${specVersionId}/explainer.html`;
}

export function safeArtifactAbsolutePath(relativePath: string, root: string) {
  const base = resolve(root, "artifacts", "products");
  const target = resolve(root, relativePath);
  if (target === base || !target.startsWith(`${base}${sep}`)) throw new Error("Artifact path is outside managed artifact directory");
  return target;
}

export function artifactAbsolutePathForRecord(record: ArchitectureDocumentRecord, root = process.cwd()) {
  if (!record.artifactPath) throw new Error("Architecture artifact is not available");
  if (record.artifactPath !== architectureArtifactPath(record.productSlug, record.specVersionId)) throw new Error("Artifact path does not match document identity");
  return safeArtifactAbsolutePath(record.artifactPath, root);
}

function jsonParam(value: unknown) {
  return value === undefined ? null : JSON.stringify(value);
}

export async function saveArchitectureDocument(input: ArchitectureDocumentInput) {
  await getDb().execute(
    `INSERT INTO architecture_documents
      (product_id, spec_version_id, revision, status, spec_json, spec_sha256, artifact_path, artifact_sha256, validation_receipt, visual_receipt, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       revision = VALUES(revision), status = VALUES(status), spec_json = VALUES(spec_json), spec_sha256 = VALUES(spec_sha256),
       artifact_path = VALUES(artifact_path), artifact_sha256 = VALUES(artifact_sha256),
       validation_receipt = VALUES(validation_receipt), visual_receipt = VALUES(visual_receipt), error_message = VALUES(error_message)`,
    [input.productId, input.specVersionId, input.revision, input.status, input.specJson, input.specSha256, input.artifactPath, input.artifactSha256, jsonParam(input.validationReceipt), jsonParam(input.visualReceipt), input.errorMessage],
  );
}

export async function getProductIdentity(productId: number) {
  const [rows] = await getDb().execute("SELECT id, slug, name FROM products WHERE id = ?", [productId]);
  return (rows as Array<{ id: number; slug: string; name: string }>)[0];
}

function mapArchitectureRow(row: ArchitectureDocumentRecord & { id: number }) {
  return { ...row, validationReceipt: parseJsonValue(row.validationReceipt), visualReceipt: parseJsonValue(row.visualReceipt) };
}

export async function getLatestArchitectureDocument(productId: number) {
  const [rows] = await getDb().execute(
    `SELECT d.id, d.product_id AS productId, d.spec_version_id AS specVersionId, d.revision, d.status,
            d.spec_json AS specJson, d.spec_sha256 AS specSha256, d.artifact_path AS artifactPath,
            d.artifact_sha256 AS artifactSha256, d.validation_receipt AS validationReceipt,
            d.visual_receipt AS visualReceipt, d.error_message AS errorMessage,
            p.slug AS productSlug, p.name AS productName
     FROM architecture_documents d JOIN products p ON p.id = d.product_id WHERE d.product_id = ? ORDER BY d.id DESC LIMIT 1`,
    [productId],
  );
  const row = (rows as Array<ArchitectureDocumentRecord & { id: number }>)[0];
  return row ? mapArchitectureRow(row) : undefined;
}

export async function getArchitectureDocument(id: number) {
  const [rows] = await getDb().execute(
    `SELECT d.id, d.product_id AS productId, d.spec_version_id AS specVersionId, d.revision, d.status,
            d.spec_json AS specJson, d.spec_sha256 AS specSha256, d.artifact_path AS artifactPath,
            d.artifact_sha256 AS artifactSha256, d.validation_receipt AS validationReceipt,
            d.visual_receipt AS visualReceipt, d.error_message AS errorMessage,
            p.slug AS productSlug, p.name AS productName
     FROM architecture_documents d JOIN products p ON p.id = d.product_id WHERE d.id = ?`,
    [id],
  );
  const row = (rows as Array<ArchitectureDocumentRecord & { id: number }>)[0];
  if (!row) return undefined;
  return mapArchitectureRow(row);
}
