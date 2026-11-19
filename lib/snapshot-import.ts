import { z } from "zod";

/**
 * BYO 快照导入（设计 2026-11-18-radar-import-byo §4/§5/§6，2026-11-19 落地）：
 * 校验链（§4.2）→ 目标产品解析（幂等 / 复用空产品 / 新建，§5）→ 草稿落库（source=
 * 'ai_snapshot_import'，§6/§7）。纯校验与编排分离；DB 访问由调用方注入 execute。
 *
 * 诚实语义：contractVersion 不兼容返回 contract_version_mismatch（409），不做自动转换；
 * 目标产品已有非导入内容返回 product_has_content（409），不合并——合并属 Stage B。
 */

export const SNAPSHOT_ARTIFACT_KIND = "codelphi-radar-snapshot";
export const SNAPSHOT_EXPORT_VERSION = 1;
export const IMPORT_SOURCE = "ai_snapshot_import";

/**
 * 字段宽度上限对齐 DB 列宽（防垃圾，不防规模）：知识数量没有上限——大仓库的合法快照
 * 原样导入（2026-11-19 用户裁决，撤销数量天花板）。传输层防护 = nginx 20m 请求体上限。
 */
export const IMPORT_LIMITS = {
  anchorPathLength: 300,
  featureNameLength: 191,
  summaryLength: 8000,
  scenarioFieldLength: 8000,
  referenceLength: 32,
};

const anchorSchema = z.object({
  path: z.string().min(1).max(IMPORT_LIMITS.anchorPathLength).refine((path) => !path.startsWith("/") && !path.includes(".."), "evidence path must be repo-relative"),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

const scenarioSchema = z.object({
  reference: z.string().trim().min(1).max(IMPORT_LIMITS.referenceLength),
  context: z.string().min(1).max(IMPORT_LIMITS.scenarioFieldLength),
  action: z.string().min(1).max(IMPORT_LIMITS.scenarioFieldLength),
  outcome: z.string().min(1).max(IMPORT_LIMITS.scenarioFieldLength),
  category: z.enum(["happy", "edge", "error"]),
  step: z.number().int().positive().nullable().optional(),
  evidence: z.array(anchorSchema),
});

const featureSchema = z.object({
  name: z.string().trim().min(1).max(IMPORT_LIMITS.featureNameLength),
  summary: z.string().max(IMPORT_LIMITS.summaryLength),
  scenarios: z.array(scenarioSchema).min(1),
});

const identitySchema = z.object({
  name: z.string().trim().min(1).max(191),
  revision: z.string().regex(/^[0-9a-f]{40,64}$/),
  treeSha: z.string().regex(/^[0-9a-f]{40,64}$/).optional(),
  originRemote: z.string().max(300).nullable().optional(),
  repositoryUrl: z.string().max(300).optional(),
  workingTreeDirty: z.boolean(),
  branch: z.string().max(191).nullable().optional(),
});

export const importArtifactSchema = z.object({
  artifactKind: z.literal(SNAPSHOT_ARTIFACT_KIND),
  exportVersion: z.literal(SNAPSHOT_EXPORT_VERSION),
  contractVersion: z.string().trim().min(1).max(32),
  identity: identitySchema,
  language: z.enum(["zh-CN", "en"]),
  features: z.array(featureSchema).min(1),
});

export type ImportArtifact = z.infer<typeof importArtifactSchema>;

export interface ImportArtifactFeatures {
  name: string;
  summary: string;
  scenarios: Array<{
    reference: string;
    context: string;
    action: string;
    outcome: string;
    category: "happy" | "edge" | "error";
    step: number | null;
    evidence: Array<{ path: string; startLine: number | null; endLine: number | null }>;
  }>;
}

export class ImportValidationError extends Error {
  code: "invalid_artifact" | "contract_version_mismatch" | "duplicate_reference" | "product_has_content";
  details: unknown;
  constructor(code: ImportValidationError["code"], message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** 校验链（§4.2）：artifactKind/exportVersion → zod 全量 → 引用唯一性。contractVersion 由调用方比对后抛 mismatch。 */
export function validateImportArtifact(raw: unknown, currentContractVersion: string): ImportArtifactFeatures[] {
  const parsed = importArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ImportValidationError("invalid_artifact", "artifact failed schema validation", parsed.error.issues.slice(0, 20));
  }
  if (parsed.data.contractVersion !== currentContractVersion) {
    throw new ImportValidationError("contract_version_mismatch", `artifact contract ${parsed.data.contractVersion} does not match server contract ${currentContractVersion}`);
  }
  for (const feature of parsed.data.features) {
    const seen = new Set<string>();
    for (const scenario of feature.scenarios) {
      if (seen.has(scenario.reference)) {
        throw new ImportValidationError("duplicate_reference", `duplicate scenario reference ${feature.name}#${scenario.reference}`);
      }
      seen.add(scenario.reference);
    }
  }
  return parsed.data.features.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    scenarios: feature.scenarios.map((scenario) => ({
      reference: scenario.reference,
      context: scenario.context,
      action: scenario.action,
      outcome: scenario.outcome,
      category: scenario.category,
      step: scenario.step ?? null,
      evidence: scenario.evidence.map((anchor) => ({ path: anchor.path, startLine: anchor.startLine ?? null, endLine: anchor.endLine ?? null })),
    })),
  }));
}

export function slugifyRepoName(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96);
  return slug || "imported-repo";
}

export function parseGithubOrigin(originRemote: string | null | undefined): { owner: string; name: string } | null {
  if (!originRemote) return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(originRemote.trim());
  if (!match) return null;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  return { owner, name };
}

export interface ImportDecision {
  mode: "idempotent" | "reuse_empty_product" | "create_product";
  productId?: number;
  slug?: string;
  reason?: string;
}

export interface ImportDeps {
  execute: (sql: string, params?: unknown[]) => Promise<unknown>;
  currentContractVersion: string;
  organizationId: number;
}

function rowsOf(result: unknown): Array<any> {
  const payload = Array.isArray(result) ? result[0] : result;
  return (Array.isArray(payload) ? payload : []) as Array<any>;
}

/** 幂等：同 org 内同 seeded_snapshot_sha 的既有导入直接返回回执；treeSha 不同即内容漂移，拒绝。 */
async function findIdempotentImport(deps: ImportDeps, artifactIdentity: { revision: string; treeSha?: string }): Promise<ImportDecision | null> {
  const rows = rowsOf(await deps.execute(
    "SELECT id, slug, seeded_tree_sha AS seededTreeSha FROM products WHERE organization_id = ? AND seeded_snapshot_sha = ? LIMIT 1",
    [deps.organizationId, artifactIdentity.revision],
  ));
  const row = rows[0] as { id: number; slug: string; seededTreeSha: string | null } | undefined;
  if (!row) return null;
  if (artifactIdentity.treeSha && row.seededTreeSha && row.seededTreeSha !== artifactIdentity.treeSha) {
    throw new ImportValidationError("contract_version_mismatch", `same revision ${artifactIdentity.revision} was previously imported with a different tree; refusing ambiguous re-import`);
  }
  return { mode: "idempotent", productId: Number(row.id), slug: String(row.slug) };
}

/** 复用：origin 指向的仓库已在本 org 的产品下且该产品工作台为空（未导入未分析）→ 复用。 */
async function findReusableEmptyProduct(deps: ImportDeps, origin: { owner: string; name: string } | null): Promise<ImportDecision | null> {
  if (!origin) return null;
  const rows = rowsOf(await deps.execute(
    `SELECT p.id AS productId, p.slug, (SELECT COUNT(*) FROM features f WHERE f.product_id = p.id AND f.active = 1) AS activeFeatures
     FROM repositories r JOIN products p ON p.id = r.product_id
     WHERE p.organization_id = ? AND r.provider = 'github' AND r.owner = ? AND r.name = ? LIMIT 1`,
    [deps.organizationId, origin.owner, origin.name],
  ));
  const row = rows[0] as { productId: number; slug: string; activeFeatures: number } | undefined;
  if (!row) return null;
  if (Number(row.activeFeatures) > 0) {
    throw new ImportValidationError("product_has_content", `product ${row.slug} already has ledger content; import into empty products only (merge is Stage B)`);
  }
  return { mode: "reuse_empty_product", productId: Number(row.productId), slug: String(row.slug) };
}

interface ResolvedTarget {
  mode: ImportDecision["mode"];
  productId: number;
  slug: string;
  binding: "created" | "existing" | "unbound";
}

/** 目标产品解析（§5）：幂等命中 > 复用空产品 > 新建（slug 冲突自动加后缀）。 */
async function resolveTargetProduct(deps: ImportDeps, identity: ImportArtifact["identity"], language: "zh-CN" | "en", origin: { owner: string; name: string } | null, slugHint?: string): Promise<ResolvedTarget> {
  const existing = await findIdempotentImport(deps, { revision: identity.revision, treeSha: identity.treeSha });
  if (existing) {
    return { mode: "idempotent", productId: existing.productId!, slug: existing.slug!, binding: "existing" };
  }
  const reusable = await findReusableEmptyProduct(deps, origin);
  if (reusable) {
    return { mode: "reuse_empty_product", productId: reusable.productId!, slug: reusable.slug!, binding: "existing" };
  }
  const base = slugifyRepoName(slugHint ?? identity.name);
  let slug = base;
  for (let attempt = 2; attempt < 50; attempt += 1) {
    const taken = rowsOf(await deps.execute("SELECT id FROM products WHERE organization_id = ? AND slug = ? LIMIT 1", [deps.organizationId, slug]));
    if (taken.length === 0) break;
    slug = `${base}-${attempt}`;
  }
  const insertResult = await deps.execute(
    `INSERT INTO products (slug, name, description, organization_id, analyze_mode, output_language)
     VALUES (?, ?, '', ?, 'incremental', ?)`,
    [slug, identity.name.slice(0, 191), deps.organizationId, language],
  );
  const insert = (Array.isArray(insertResult) ? insertResult[0] : insertResult) as { insertId: number };
  return {
    mode: "create_product",
    productId: Number(insert.insertId),
    slug,
    binding: origin ? "created" : "unbound",
  };
}

/** 仓库行登记：origin 是 github 且该仓库行尚不存在时补建（已属其他产品则留待 Stage B 绑定）。 */
async function ensureRepositoryRow(deps: ImportDeps, origin: { owner: string; name: string } | null, productId: number): Promise<void> {
  if (!origin) return;
  const repoRows = rowsOf(await deps.execute(
    "SELECT id, product_id AS productId FROM repositories WHERE provider = 'github' AND owner = ? AND name = ? LIMIT 1",
    [origin.owner, origin.name],
  ));
  if (repoRows.length === 0) {
    await deps.execute(
      "INSERT INTO repositories (product_id, owner, name, provider, connection_id) VALUES (?, ?, ?, 'github', NULL)",
      [productId, origin.owner, origin.name],
    );
  }
}

/** 草稿落库：features/scenarios 双写（source='ai_snapshot_import'），返回导入场景数。 */
async function insertDraftFeatures(deps: ImportDeps, productId: number, features: ImportArtifactFeatures[]): Promise<number> {
  let scenariosImported = 0;
  for (const feature of features) {
    const featureInsertResult = await deps.execute(
      `INSERT INTO features (product_id, name, summary, source, active) VALUES (?, ?, ?, '${IMPORT_SOURCE}', 1)`,
      [productId, feature.name, feature.summary],
    );
    const featureInsert = (Array.isArray(featureInsertResult) ? featureInsertResult[0] : featureInsertResult) as { insertId: number };
    const featureId = Number(featureInsert.insertId);
    for (const scenario of feature.scenarios) {
      await deps.execute(
        `INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, active, evidence, step_order)
         VALUES (?, ?, ?, ?, ?, ?, '${IMPORT_SOURCE}', 1, ?, ?)`,
        [featureId, scenario.reference, scenario.context, scenario.action, scenario.outcome, scenario.category, JSON.stringify(scenario.evidence), scenario.step],
      );
      scenariosImported += 1;
    }
  }
  return scenariosImported;
}

export async function importSnapshotArtifact(deps: ImportDeps, raw: unknown, identityInput?: { slug?: string }): Promise<{ productId: number; slug: string; featuresImported: number; scenariosImported: number; mode: ImportDecision["mode"]; binding: "created" | "existing" | "unbound" }> {
  const features = validateImportArtifact(raw, deps.currentContractVersion);
  const artifact = raw as ImportArtifact;
  const identity = artifact.identity;
  const origin = parseGithubOrigin(identity.originRemote ?? identity.repositoryUrl);
  const target = await resolveTargetProduct(deps, identity, artifact.language, origin, identityInput?.slug);
  if (origin && target.binding !== "existing") {
    await ensureRepositoryRow(deps, origin, target.productId);
  }
  const scenariosImported = await insertDraftFeatures(deps, target.productId, features);
  await deps.execute(
    `UPDATE products SET seeded_snapshot_sha = ?, seeded_tree_sha = ?, seeded_dirty = ?, seeded_contract_version = ?, seeded_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
    [identity.revision, identity.treeSha ?? null, identity.workingTreeDirty ? 1 : 0, artifact.contractVersion, target.productId],
  );
  return { productId: target.productId, slug: target.slug, featuresImported: features.length, scenariosImported, mode: target.mode, binding: target.binding };
}
