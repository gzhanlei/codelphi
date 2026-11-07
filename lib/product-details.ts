import { getDb } from "./db";
import { evidenceItems } from "./evidence";
import { evidenceUrl } from "./evidence-url";
import { parseJsonValue } from "./json";
import { RELEASE_PAGE_SIZE, type ReleasePagePayload } from "./release-client";
import { loadRegressionStatuses } from "./regression";
import { annotateSuspectedRenames } from "./spec-rename";
import type { BehaviorChangeRow, ChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "./types";

interface EvidenceSource {
  owner: string;
  name: string;
  revision: string;
}

/** 给证据条目补上可点击的 blob 链接（AI 已给 url 的不覆盖；无 revision 时原样返回）。 */
function decorateEvidence(value: unknown, source?: EvidenceSource): unknown {
  if (!source) return value;
  const items = evidenceItems(value);
  if (items.length === 0) return value;
  return items.map((item) => {
    const url = item.url ?? evidenceUrl(source, source.revision, item);
    return url ? { ...item, url } : item;
  });
}

/** 行为变化的 before/after 主体内嵌 evidence 字段，一并装饰。 */
function decorateSubject(value: unknown, source?: EvidenceSource): unknown {
  if (!source || typeof value !== "object" || value === null || !("evidence" in value)) return value;
  const subject = value as Record<string, unknown>;
  return { ...subject, evidence: decorateEvidence(subject.evidence, source) };
}

async function queryByIds<T>(ids: number[], query: string) {
  if (ids.length === 0) return [] as T[];
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await getDb().execute(query.replace("{{placeholders}}", placeholders), ids);
  return rows as T[];
}

async function loadScenarios(features: FeatureRow[]) {
  return queryByIds<ScenarioRow>(features.map((feature) => feature.id), "SELECT id, feature_id AS featureId, reference, context, action, outcome, category, source, evidence, stale_since AS staleSince, stale_change_id AS staleChangeId FROM scenarios WHERE active = 1 AND feature_id IN ({{placeholders}}) ORDER BY reference");
}

async function loadChanges(releases: ReleaseRow[]) {
  return queryByIds<ChangeRow>(releases.map((release) => release.id), "SELECT id, release_id AS releaseId, feature_name AS featureName, kind, description, user_impact AS userImpact, evidence FROM changes WHERE release_id IN ({{placeholders}}) ORDER BY id");
}

async function loadBehaviorChanges(releases: ReleaseRow[]) {
  if (releases.length === 0) return [];
  const ids = releases.map((release) => release.id);
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await getDb().execute(
    `SELECT c.id, r.id AS releaseId, c.kind, c.entity_type AS entityType,
            c.feature_name AS featureName, c.scenario_reference AS scenarioReference,
            c.summary, c.before_json AS beforeJson, c.after_json AS afterJson
     FROM spec_changes c JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.id IN (${placeholders}) ORDER BY c.id`,
    ids,
  );
  return (rows as Array<Omit<BehaviorChangeRow, "before" | "after"> & { beforeJson: unknown; afterJson: unknown }>).map((row) => ({
    id: row.id,
    releaseId: row.releaseId,
    kind: row.kind,
    entityType: row.entityType,
    featureName: row.featureName,
    scenarioReference: row.scenarioReference,
    summary: row.summary,
    before: parseJsonValue(row.beforeJson),
    after: parseJsonValue(row.afterJson),
  }));
}

export async function getProductDetails(slug: string, organizationId?: number) {
  const db = getDb();
  const [products] = await db.execute(
    organizationId === undefined
      ? "SELECT id, slug, name, description, description_source AS descriptionSource, description_evidence AS descriptionEvidence, is_public_demo AS isPublicDemo FROM products WHERE slug = ?"
      : "SELECT id, slug, name, description, description_source AS descriptionSource, description_evidence AS descriptionEvidence, is_public_demo AS isPublicDemo FROM products WHERE slug = ? AND organization_id = ?",
    organizationId === undefined ? [slug] : [slug, organizationId],
  );
  const product = (products as Array<{ id: number; slug: string; name: string; description: string; descriptionSource: "manual" | "generated"; descriptionEvidence: unknown; isPublicDemo?: number }>)[0];
  if (!product) return null;

  const [repositories] = await db.execute("SELECT provider, owner, name, default_branch AS defaultBranch FROM repositories WHERE product_id = ?", [product.id]);
  const [runs] = await db.execute(
    `SELECT r.status, r.error_message AS errorMessage, r.after_sha AS afterSha FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id WHERE repo.product_id = ? ORDER BY r.created_at DESC LIMIT 1`,
    [product.id],
  );
  const [featureRows] = await db.execute("SELECT id, name, summary, parent_id AS parentId, source, stale_since AS staleSince, stale_change_id AS staleChangeId FROM features WHERE product_id = ? AND active = 1 ORDER BY name", [product.id]);
  const [releaseRows, countRows] = await Promise.all([
    db.execute("SELECT id, title, summary, sha, url, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT ?", [product.id, RELEASE_PAGE_SIZE]),
    db.execute("SELECT COUNT(*) AS total FROM releases WHERE product_id = ?", [product.id]),
  ]);
  const features = featureRows as FeatureRow[];
  const releases = releaseRows[0] as ReleaseRow[];
  const releaseTotal = Number((countRows[0] as Array<{ total: number }>)[0]?.total ?? 0);
  const [scenarios, changes, behaviorChanges, regressionStatuses] = await Promise.all([loadScenarios(features), loadChanges(releases), loadBehaviorChanges(releases), loadRegressionStatuses(product.id)]);

  const repository = (repositories as Array<{ provider?: string; owner: string; name: string; defaultBranch: string }>)[0];
  const afterSha = (runs as Array<{ status: string; errorMessage?: string; afterSha?: string | null }>)[0]?.afterSha;
  const source: EvidenceSource | undefined = repository && afterSha ? { owner: repository.owner, name: repository.name, revision: afterSha } : undefined;

  return {
    product: { ...product, descriptionEvidence: decorateEvidence(parseJsonValue(product.descriptionEvidence), source) },
    repository,
    latestRun: (runs as Array<{ status: string; errorMessage?: string }>)[0],
    features,
    scenarios: scenarios.map((scenario) => ({ ...scenario, evidence: decorateEvidence(scenario.evidence, source) })),
    releases,
    releaseTotal,
    changes: changes.map((change) => ({ ...change, evidence: decorateEvidence(change.evidence, source) })),
    behaviorChanges: annotateSuspectedRenames(behaviorChanges.map((change) => ({ ...change, before: decorateSubject(change.before, source), after: decorateSubject(change.after, source) }))),
    regressionStatuses,
    driftCount: features.filter((feature) => feature.staleSince).length + scenarios.filter((scenario) => scenario.staleSince).length,
  };
}

/**
 * 发布变化列表的分页读取：「加载更多」按 offset 取下一页，返回值与首屏同构
 * （证据 blob URL、疑似改名装饰均在服务端完成）。产品不存在时返回 null。
 */
export async function loadReleasePage(slug: string, organizationId: number | undefined, offset: number, limit: number): Promise<ReleasePagePayload | null> {
  const db = getDb();
  const [products] = await db.execute(
    organizationId === undefined
      ? "SELECT id FROM products WHERE slug = ?"
      : "SELECT id FROM products WHERE slug = ? AND organization_id = ?",
    organizationId === undefined ? [slug] : [slug, organizationId],
  );
  const product = (products as Array<{ id: number }>)[0];
  if (!product) return null;

  const [repositories] = await db.execute("SELECT owner, name FROM repositories WHERE product_id = ?", [product.id]);
  const [runs] = await db.execute(
    `SELECT r.after_sha AS afterSha FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id WHERE repo.product_id = ? ORDER BY r.created_at DESC LIMIT 1`,
    [product.id],
  );
  const [releaseRows, countRows] = await Promise.all([
    db.execute("SELECT id, title, summary, sha, url, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT ? OFFSET ?", [product.id, limit, offset]),
    db.execute("SELECT COUNT(*) AS total FROM releases WHERE product_id = ?", [product.id]),
  ]);
  const releases = releaseRows[0] as ReleaseRow[];
  const total = Number((countRows[0] as Array<{ total: number }>)[0]?.total ?? 0);
  const [changes, behaviorChanges] = await Promise.all([loadChanges(releases), loadBehaviorChanges(releases)]);

  const repository = (repositories as Array<{ owner: string; name: string }>)[0];
  const afterSha = (runs as Array<{ afterSha?: string | null }>)[0]?.afterSha;
  const source: EvidenceSource | undefined = repository && afterSha ? { owner: repository.owner, name: repository.name, revision: afterSha } : undefined;

  return {
    total,
    releases,
    changes: changes.map((change) => ({ ...change, evidence: decorateEvidence(change.evidence, source) })),
    behaviorChanges: annotateSuspectedRenames(behaviorChanges.map((change) => ({ ...change, before: decorateSubject(change.before, source), after: decorateSubject(change.after, source) }))),
  };
}
