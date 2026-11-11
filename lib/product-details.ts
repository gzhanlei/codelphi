import { getDb } from "./db";
import { evidenceItems } from "./evidence";
import { evidenceUrl } from "./evidence-url";
import { parseJsonValue } from "./json";
import { RELEASE_PAGE_SIZE, type ReleasePagePayload } from "./release-client";
import { loadRegressionTasks } from "./regression-tasks";
import { annotateSuspectedRenames } from "./spec-rename";
import { diffSpecWithFolded, type FoldedSpecChange, type SpecScenario } from "./spec-diff";
import { loadBaseVersionMap, loadVersionFeatureMap } from "./spec-versions";
import { loadCoverageReceipt, type CoverageReceiptRow } from "./analysis-coverage";
import { loadCompletenessLedgerBySpecVersion } from "./completeness-ledger";
import type { BehaviorChangeRow, ChangeRow, FeatureRow, FoldedBehaviorChangeRow, ReleaseRow, ScenarioRow } from "./types";

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
  return queryByIds<ScenarioRow>(features.map((feature) => feature.id), "SELECT id, feature_id AS featureId, reference, context, action, outcome, category, source, evidence, stale_since AS staleSince, stale_change_id AS staleChangeId, verified_at AS verifiedAt, verified_by AS verifiedBy, last_edited_by AS lastEditedBy, last_edited_at AS lastEditedAt FROM scenarios WHERE active = 1 AND feature_id IN ({{placeholders}}) ORDER BY reference");
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
            c.summary, c.highlight_type AS highlightType, c.highlight_reason AS highlightReason,
            c.before_json AS beforeJson, c.after_json AS afterJson
     FROM spec_changes c JOIN releases r ON r.spec_version_id = c.spec_version_id
     WHERE r.id IN (${placeholders}) AND c.wording_only = 0 ORDER BY c.id`,
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
    highlightType: row.highlightType,
    highlightReason: row.highlightReason,
    before: parseJsonValue(row.beforeJson),
    after: parseJsonValue(row.afterJson),
  }));
}

/** 折叠差异的展示摘要（发布变化视图的审计说明）。 */
function foldedSummary(folded: FoldedSpecChange) {
  if (folded.reason === "renumber") {
    const before = folded.before as SpecScenario;
    const after = folded.after as SpecScenario;
    return `场景编号调整：${before.reference} → ${after.reference}（行为等价，未计入行为变化）`;
  }
  if (folded.reason === "tests-only") {
    return "新增功能的证据全部来自测试/文档，行为性证据不足（未计入行为变化）";
  }
  return folded.entityType === "feature" ? "功能描述仅措辞调整（行为等价，未计入行为变化）" : "场景表述仅措辞差异（行为等价，未计入行为变化）";
}

/** 逐发布读取行为性变更文件集（patch-scan 落库标志）：折叠重算与保存期判定共用同一口径。 */
async function loadBehavioralPathsByRelease(releaseIds: number[]): Promise<Map<number, Set<string>>> {
  const map = new Map<number, Set<string>>();
  if (releaseIds.length === 0) return map;
  const placeholders = releaseIds.map(() => "?").join(",");
  const [rows] = await getDb().execute(
    `SELECT release_id, path FROM release_files WHERE behavioral_change = 1 AND release_id IN (${placeholders})`,
    releaseIds,
  ) as [Array<{ release_id: number; path: string }>, unknown];
  for (const row of rows) {
    let set = map.get(Number(row.release_id));
    if (!set) {
      set = new Set<string>();
      map.set(Number(row.release_id), set);
    }
    set.add(row.path);
  }
  return map;
}

/** 逐发布重算被等价判定折叠的差异（落库行只有变化，折叠项不落库，现算是唯一完整口径）。 */
async function loadFoldedChanges(releases: ReleaseRow[]): Promise<FoldedBehaviorChangeRow[]> {
  const versionIds = [...new Set(releases.map((release) => release.specVersionId).filter((id): id is number => id !== null))];
  if (versionIds.length === 0) return [];
  const baseMap = await loadBaseVersionMap(getDb().execute.bind(getDb()), versionIds);
  const needed = [...new Set([...versionIds, ...[...baseMap.values()].filter((id): id is number => id !== null)])];
  const featureMap = await loadVersionFeatureMap(getDb().execute.bind(getDb()), needed);
  const behavioralByRelease = await loadBehavioralPathsByRelease(releases.map((release) => release.id));
  const folded: FoldedBehaviorChangeRow[] = [];
  let syntheticId = 0;
  for (const release of releases) {
    if (release.specVersionId === null) continue;
    const base = baseMap.get(release.specVersionId);
    const behavioral = behavioralByRelease.get(release.id);
    const outcome = diffSpecWithFolded(
      base === null || base === undefined ? null : featureMap.get(base) ?? null,
      featureMap.get(release.specVersionId) ?? [],
      behavioral ? { behavioralChangePaths: behavioral } : undefined,
    );
    for (const item of outcome.folded) {
      folded.push({
        id: --syntheticId,
        releaseId: release.id,
        kind: "changed",
        entityType: item.entityType,
        featureName: item.featureName,
        scenarioReference: item.scenarioReference ?? "",
        summary: foldedSummary(item),
        before: item.before,
        after: item.after,
        reason: item.reason,
      });
    }
  }
  return folded;
}

export async function getProductDetails(slug: string, organizationId?: number) {
  const db = getDb();
  const [products] = await db.execute(
    organizationId === undefined
      ? "SELECT id, slug, name, description, description_source AS descriptionSource, description_evidence AS descriptionEvidence, positioning_json AS positioning, is_public_demo AS isPublicDemo FROM products WHERE slug = ?"
      : "SELECT id, slug, name, description, description_source AS descriptionSource, description_evidence AS descriptionEvidence, positioning_json AS positioning, is_public_demo AS isPublicDemo FROM products WHERE slug = ? AND organization_id = ?",
    organizationId === undefined ? [slug] : [slug, organizationId],
  );
  const product = (products as Array<{ id: number; slug: string; name: string; description: string; descriptionSource: "manual" | "generated"; descriptionEvidence: unknown; positioning?: unknown; isPublicDemo?: number }>)[0];
  if (!product) return null;

  const [repositories] = await db.execute("SELECT provider, owner, name, default_branch AS defaultBranch FROM repositories WHERE product_id = ?", [product.id]);
  const [runs] = await db.execute(
    `SELECT r.status, r.error_message AS errorMessage, r.after_sha AS afterSha FROM analysis_runs r
     JOIN repositories repo ON repo.id = r.repository_id WHERE repo.product_id = ? ORDER BY r.created_at DESC LIMIT 1`,
    [product.id],
  );
  const [featureRows] = await db.execute("SELECT id, name, summary, parent_id AS parentId, source, stale_since AS staleSince, stale_change_id AS staleChangeId, verified_at AS verifiedAt, verified_by AS verifiedBy, last_edited_by AS lastEditedBy, last_edited_at AS lastEditedAt FROM features WHERE product_id = ? AND active = 1 ORDER BY name", [product.id]);
  const [releaseRows, countRows] = await Promise.all([
    db.execute("SELECT id, title, summary, sha, url, committed_at AS committedAt, spec_version_id AS specVersionId FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT ?", [product.id, RELEASE_PAGE_SIZE]),
    db.execute("SELECT COUNT(*) AS total FROM releases WHERE product_id = ?", [product.id]),
  ]);
  const features = featureRows as FeatureRow[];
  const releases = releaseRows[0] as ReleaseRow[];
  const releaseTotal = Number((countRows[0] as Array<{ total: number }>)[0]?.total ?? 0);
  const [scenarios, changes, behaviorChanges, regressionTasks, foldedChanges] = await Promise.all([loadScenarios(features), loadChanges(releases), loadBehaviorChanges(releases), loadRegressionTasks(product.id), loadFoldedChanges(releases)]);
  // B1 覆盖披露：最新发布对应的覆盖率回执（migration 054 之前的历史版本无回执，为 null）。
  // BM-10 沿用版本不落自有回执 → 沿版本链向上取最近有效回执（沿用版本的覆盖面 = 被沿用版本的
  // 覆盖面）；合成零回执（implFilesTotal = 0）同样视为无、跳过。
  const latestSpecVersionId = releases[0]?.specVersionId ?? null;
  let coverage: CoverageReceiptRow | null = null;
  if (latestSpecVersionId !== null) {
    const candidates = [...new Set([latestSpecVersionId, ...releases.map((release) => release.specVersionId).filter((id): id is number => typeof id === "number")])].slice(0, 6);
    for (const candidateId of candidates) {
      const receipt = await loadCoverageReceipt(db.execute.bind(db) as (sql: string, params?: unknown[]) => Promise<unknown>, candidateId);
      if (receipt && receipt.implFilesTotal > 0) { coverage = receipt; break; }
    }
  }
  // R1 分析完整性账本：与覆盖率回执同源同点加载（run 级 best-effort 写入，历史版本为 null）
  const completeness = latestSpecVersionId === null ? null : await loadCompletenessLedgerBySpecVersion(db.execute.bind(db) as (sql: string, params?: unknown[]) => Promise<unknown>, latestSpecVersionId);

  const repository = (repositories as Array<{ provider?: string; owner: string; name: string; defaultBranch: string }>)[0];
  const afterSha = (runs as Array<{ status: string; errorMessage?: string; afterSha?: string | null }>)[0]?.afterSha;
  const source: EvidenceSource | undefined = repository && afterSha ? { owner: repository.owner, name: repository.name, revision: afterSha } : undefined;

  // 发布稿状态（入口提亮 + 总览时间线）：全量映射（状态 + 合成标题）+ 最近一次发布的详细状态
  const [noteRows] = await db.execute(
    "SELECT id, release_id AS releaseId, status, headline FROM release_notes WHERE product_id = ?",
    [product.id],
  );
  const releaseNotes = noteRows as Array<{ id: number; releaseId: number; status: string; headline: string | null }>;
  const [noteDetailRows] = await db.execute(
    `SELECT n.status, n.release_id AS releaseId, n.published_at AS publishedAt,
            (SELECT COUNT(*) FROM release_note_blocks b WHERE b.release_note_id = n.id) AS blocks
     FROM release_notes n
     WHERE n.product_id = ? AND n.release_id = (SELECT id FROM releases WHERE product_id = ? ORDER BY committed_at DESC LIMIT 1)
     LIMIT 1`,
    [product.id, product.id],
  );
  const latestReleaseNote = (noteDetailRows as Array<{ status: string; releaseId: number; publishedAt: Date | null; blocks: number }>)[0] ?? null;

  return {
    product: { ...product, descriptionEvidence: decorateEvidence(parseJsonValue(product.descriptionEvidence), source) },
    releaseNotes,
    latestReleaseNote: latestReleaseNote ?? null,
    repository,
    latestRun: (runs as Array<{ status: string; errorMessage?: string }>)[0],
    features,
    scenarios: scenarios.map((scenario) => ({ ...scenario, evidence: decorateEvidence(scenario.evidence, source) })),
    releases,
    releaseTotal,
    changes: changes.map((change) => ({ ...change, evidence: decorateEvidence(change.evidence, source) })),
    behaviorChanges: annotateSuspectedRenames(behaviorChanges.map((change) => ({ ...change, before: decorateSubject(change.before, source), after: decorateSubject(change.after, source) }))),
    regressionTasks,
    foldedChanges: foldedChanges.map((change) => ({ ...change, before: decorateSubject(change.before, source), after: decorateSubject(change.after, source) })),
    coverage,
    completeness,
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
  const [changes, behaviorChanges, foldedChanges] = await Promise.all([loadChanges(releases), loadBehaviorChanges(releases), loadFoldedChanges(releases)]);

  const repository = (repositories as Array<{ owner: string; name: string }>)[0];
  const afterSha = (runs as Array<{ afterSha?: string | null }>)[0]?.afterSha;
  const source: EvidenceSource | undefined = repository && afterSha ? { owner: repository.owner, name: repository.name, revision: afterSha } : undefined;

  return {
    total,
    releases,
    changes: changes.map((change) => ({ ...change, evidence: decorateEvidence(change.evidence, source) })),
    behaviorChanges: annotateSuspectedRenames(behaviorChanges.map((change) => ({ ...change, before: decorateSubject(change.before, source), after: decorateSubject(change.after, source) }))),
    foldedChanges: foldedChanges.map((change) => ({ ...change, before: decorateSubject(change.before, source), after: decorateSubject(change.after, source) })),
  };
}
