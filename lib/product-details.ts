import { getDb } from "./db";
import { parseJsonValue } from "./json";
import { getLatestArchitectureDocument } from "./architecture-store";
import type { BehaviorChangeRow, ChangeRow, FeatureRow, ReleaseRow, ScenarioRow } from "./types";

async function queryByIds<T>(ids: number[], query: string) {
  if (ids.length === 0) return [] as T[];
  const placeholders = ids.map(() => "?").join(",");
  const [rows] = await getDb().execute(query.replace("{{placeholders}}", placeholders), ids);
  return rows as T[];
}

async function loadScenarios(features: FeatureRow[]) {
  return queryByIds<ScenarioRow>(features.map((feature) => feature.id), "SELECT id, feature_id AS featureId, reference, context, action, outcome, category, source, evidence FROM scenarios WHERE active = 1 AND feature_id IN ({{placeholders}}) ORDER BY reference");
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
      ? "SELECT id, slug, name, description FROM products WHERE slug = ?"
      : "SELECT id, slug, name, description FROM products WHERE slug = ? AND organization_id = ?",
    organizationId === undefined ? [slug] : [slug, organizationId],
  );
  const product = (products as Array<{ id: number; slug: string; name: string; description: string }>)[0];
  if (!product) return null;

  const [repositories] = await db.execute("SELECT owner, name, default_branch AS defaultBranch FROM repositories WHERE product_id = ?", [product.id]);
  const [runs] = await db.execute(
    `SELECT r.status, r.error_message AS errorMessage FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id WHERE repo.product_id = ? ORDER BY r.created_at DESC LIMIT 1`,
    [product.id],
  );
  const [featureRows] = await db.execute("SELECT id, name, summary, parent_id AS parentId, source FROM features WHERE product_id = ? AND active = 1 ORDER BY name", [product.id]);
  const [releaseRows] = await db.execute("SELECT id, title, summary, sha, url, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT 30", [product.id]);
  const features = featureRows as FeatureRow[];
  const releases = releaseRows as ReleaseRow[];
  const [scenarios, changes, behaviorChanges, architecture] = await Promise.all([loadScenarios(features), loadChanges(releases), loadBehaviorChanges(releases), getLatestArchitectureDocument(product.id)]);

  return {
    product,
    repository: (repositories as Array<{ owner: string; name: string; defaultBranch: string }>)[0],
    latestRun: (runs as Array<{ status: string; errorMessage?: string }>)[0],
    features,
    scenarios,
    releases,
    changes,
    behaviorChanges,
    architecture,
  };
}
