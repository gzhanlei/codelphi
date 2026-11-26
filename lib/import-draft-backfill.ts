/**
 * 导入草稿的回填（原规格 §16.3 的路径 B；修订稿 §4.2「旧客户端迁移」）。
 *
 * 雷达快照的导入只写工作台草稿（source = 'ai_snapshot_import'），不写规格版本、发布和分析记录。
 * 回填把这样的一份草稿写成它的第一个规格版本：不读源码、不调模型、不访问网络，只把库里已有的行
 * 经托管分析用的同一个合并入口（saveResultInTransaction）写成版本、发布和一条回执 run。
 *
 * 几件事是故意这么定的：
 * - 演练就是「在事务里真做一遍，再回滚」。合并入口里有确定性的去重和「人工条目优先」的规则，
 *   不真做一遍就说不准哪些草稿行进不了版本；演练给出的就是实际结果，不是估算。
 * - 条件不满足就拒绝，整个事务回滚。条件是原规格列的那几条，外加「工作台里已经有分析的痕迹」。
 * - 草稿行的来源在同一个事务里改成 generated：合并入口只更新 generated 的行，不改来源的话，之后的发布
 *   既更新不了这些行，也不会下线已经消失的功能。行的编号不变，人工改过的行（来源是 manual）不碰。
 * - 服务端不知道那个提交是什么时候提交的。写入时必须由调用方给出，不拿导入时间冒充。
 */
import type { Pool, PoolConnection } from "mysql2/promise";
import { saveResultInTransaction, type RunContext } from "./analysis";
import { IMPORT_BACKFILL_TRIGGER } from "./analysis-executor";
import type { AnalysisResult } from "./ai";
import type { CodeHostingProvider } from "./code-hosting";
import type { Execute } from "./db";
import { IMPORT_SOURCE } from "./snapshot-import";

/** 导入只会给 origin 在 github.com 的仓库建仓库行；别家主机的提交页地址这里不猜，没有链接就只显示提交号。 */
const GITHUB = "github.com";

export type BackfillBlocker =
  | "product_not_found"
  | "repository_missing"
  | "repository_ambiguous"
  | "repository_unsupported"
  | "not_imported"
  | "seeded_incomplete"
  | "dirty_snapshot"
  | "contract_version_drift"
  | "already_has_versions"
  | "generated_rows_present"
  | "draft_modified"
  | "draft_empty"
  | "draft_duplicates";

export interface BackfillBlockage {
  code: BackfillBlocker;
  detail: string;
}

/** 条件不满足。blockages 说全了是哪几条，方便一次看明白，而不是改一条再撞下一条。 */
export class ImportBackfillRefused extends Error {
  readonly blockages: BackfillBlockage[];

  constructor(blockages: BackfillBlockage[]) {
    super(blockages.map((blockage) => `${blockage.code}: ${blockage.detail}`).join("; "));
    this.name = "ImportBackfillRefused";
    this.blockages = blockages;
  }
}

export interface BackfillTarget {
  slug: string;
  organizationId: number;
}

export interface DraftBackfillCandidate {
  productId: number;
  organizationId: number;
  slug: string;
  productName: string;
  outputLanguage: "zh-CN" | "en";
  analysisExecutor: string;
  seeded: {
    snapshotSha: string | null;
    treeSha: string | null;
    dirty: boolean;
    contractVersion: string | null;
    importedAt: Date | null;
  };
  repository: { id: number; provider: string; host: string | null; owner: string; name: string } | null;
  repositoryCount: number;
  versionCount: number;
  /** 工作台的计数，键是「来源:在用或停用」，例如 ai_snapshot_import:active。 */
  workbench: { features: Record<string, number>; scenarios: Record<string, number> };
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  const payload = Array.isArray(result) ? result[0] : result;
  return (Array.isArray(payload) ? payload : []) as Array<Record<string, unknown>>;
}

const tallyOf = (rows: Array<Record<string, unknown>>): Record<string, number> => {
  const tally: Record<string, number> = {};
  for (const row of rows) tally[`${String(row.source)}:${Number(row.active) === 1 ? "active" : "inactive"}`] = Number(row.count);
  return tally;
};

/** 读回填要看的全部事实。产品不在这个组织里就返回 null。只读。 */
export async function loadBackfillCandidate(execute: Execute, target: BackfillTarget): Promise<DraftBackfillCandidate | null> {
  const products = rowsOf(await execute(
    `SELECT id, slug, name, organization_id AS organizationId, output_language AS outputLanguage, analysis_executor AS analysisExecutor,
            seeded_snapshot_sha AS seededSnapshotSha, seeded_tree_sha AS seededTreeSha, seeded_dirty AS seededDirty,
            seeded_contract_version AS seededContractVersion, seeded_at AS seededAt
     FROM products WHERE organization_id = ? AND slug = ? LIMIT 1`,
    [target.organizationId, target.slug],
  ));
  const product = products[0];
  if (!product) return null;
  const productId = Number(product.id);
  const [repositories, versions, featureRows, scenarioRows] = await Promise.all(
    [
      "SELECT id, provider, host, owner, name FROM repositories WHERE product_id = ? ORDER BY id",
      "SELECT COUNT(*) AS count FROM spec_versions WHERE repository_id IN (SELECT id FROM repositories WHERE product_id = ?)",
      "SELECT source, active, COUNT(*) AS count FROM features WHERE product_id = ? GROUP BY source, active",
      "SELECT s.source, s.active, COUNT(*) AS count FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE f.product_id = ? GROUP BY s.source, s.active",
    ].map(async (statement) => rowsOf(await execute(statement, [productId]))),
  );
  const repository = repositories[0];
  return {
    productId,
    organizationId: Number(product.organizationId),
    slug: String(product.slug),
    productName: String(product.name),
    outputLanguage: product.outputLanguage === "en" ? "en" : "zh-CN",
    analysisExecutor: String(product.analysisExecutor),
    seeded: {
      snapshotSha: product.seededSnapshotSha == null ? null : String(product.seededSnapshotSha),
      treeSha: product.seededTreeSha == null ? null : String(product.seededTreeSha),
      dirty: Number(product.seededDirty) === 1,
      contractVersion: product.seededContractVersion == null ? null : String(product.seededContractVersion),
      importedAt: product.seededAt == null ? null : new Date(product.seededAt as string | Date),
    },
    repository: repository
      ? { id: Number(repository.id), provider: String(repository.provider), host: repository.host == null ? null : String(repository.host), owner: String(repository.owner), name: String(repository.name) }
      : null,
    repositoryCount: repositories.length,
    versionCount: Number(versions[0]?.count ?? 0),
    workbench: { features: tallyOf(featureRows), scenarios: tallyOf(scenarioRows) },
  };
}

const GENERATED = ["features", "scenarios"] as const;

/** 原规格给路径 B 列的条件，外加「这个产品已经分析过」的两种痕迹。人工条目不算障碍。 */
export function blockagesOf(
  candidate: DraftBackfillCandidate,
  options: { currentContractVersion: string; acceptContractDrift?: boolean },
): BackfillBlockage[] {
  const blockages: BackfillBlockage[] = [];
  const { repository, repositoryCount, seeded, versionCount, workbench } = candidate;
  if (repositoryCount === 0) {
    blockages.push({ code: "repository_missing", detail: "产品没有仓库行；规格版本和发布都挂在仓库行上" });
  } else if (repositoryCount > 1) {
    blockages.push({ code: "repository_ambiguous", detail: `产品下有 ${repositoryCount} 条仓库行，说不清该挂在哪一条上` });
  } else if (repository && repository.provider !== "github") {
    blockages.push({ code: "repository_unsupported", detail: `仓库的托管方是 ${repository.provider}，导入只会给 github.com 的仓库建行` });
  }
  if (!seeded.snapshotSha) {
    blockages.push({ code: "not_imported", detail: "产品不是快照导入产生的（没有登记快照对应的提交）" });
  } else {
    if (!seeded.treeSha || !seeded.contractVersion) blockages.push({ code: "seeded_incomplete", detail: "导入登记不完整（缺树哈希或契约版本）" });
    if (seeded.dirty) blockages.push({ code: "dirty_snapshot", detail: "快照是在有未提交改动的工作区里生成的，对不上任何一个提交" });
    if (seeded.contractVersion && seeded.contractVersion !== options.currentContractVersion && !options.acceptContractDrift) {
      blockages.push({ code: "contract_version_drift", detail: `导入时的契约是 ${seeded.contractVersion}，现在是 ${options.currentContractVersion}` });
    }
  }
  if (versionCount > 0) blockages.push({ code: "already_has_versions", detail: `仓库已经有 ${versionCount} 个规格版本，不再是「只有草稿」` });
  if (GENERATED.some((table) => (workbench[table][`generated:active`] ?? 0) + (workbench[table][`generated:inactive`] ?? 0) > 0)) {
    blockages.push({ code: "generated_rows_present", detail: "工作台里已经有分析产生的条目" });
  }
  if (GENERATED.some((table) => (workbench[table][`${IMPORT_SOURCE}:inactive`] ?? 0) > 0)) {
    blockages.push({ code: "draft_modified", detail: "有导入的条目被停用了；编辑和删除会把来源改成 manual，停用而来源没变说明被别的东西改过" });
  }
  if ((workbench.features[`${IMPORT_SOURCE}:active`] ?? 0) === 0) {
    blockages.push({ code: "draft_empty", detail: "工作台里没有还在用的导入条目" });
  }
  return blockages;
}

export interface DraftScenarioRow {
  id: number;
  featureId: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: "happy" | "edge" | "error";
  stepOrder: number | null;
  evidence: unknown;
}

export interface DraftFeatureRow {
  id: number;
  name: string;
  summary: string;
}

export interface DraftRows {
  /** 按导入时的顺序（编号从小到大）。 */
  features: DraftFeatureRow[];
  scenarios: DraftScenarioRow[];
}

/** 在用的导入条目。人工改过的条目来源已经是 manual，不在这里，由合并入口自己并入版本。 */
export async function loadDraftRows(execute: Execute, productId: number): Promise<DraftRows> {
  const [featureResult, scenarioResult] = await Promise.all([
    execute("SELECT id, name, summary FROM features WHERE product_id = ? AND active = 1 AND source = ? ORDER BY id", [productId, IMPORT_SOURCE]),
    execute(
      `SELECT s.id, s.feature_id AS featureId, s.reference, s.context, s.action, s.outcome, s.category, s.step_order AS stepOrder, s.evidence
       FROM scenarios s JOIN features f ON f.id = s.feature_id
       WHERE f.product_id = ? AND f.active = 1 AND f.source = ? AND s.active = 1 AND s.source = ? ORDER BY s.id`,
      [productId, IMPORT_SOURCE, IMPORT_SOURCE],
    ),
  ]);
  return {
    features: rowsOf(featureResult).map((row) => ({ id: Number(row.id), name: String(row.name), summary: String(row.summary) })),
    scenarios: rowsOf(scenarioResult).map((row) => ({
      id: Number(row.id),
      featureId: Number(row.featureId),
      reference: String(row.reference),
      context: String(row.context),
      action: String(row.action),
      outcome: String(row.outcome),
      category: row.category as DraftScenarioRow["category"],
      stepOrder: row.stepOrder == null ? null : Number(row.stepOrder),
      evidence: row.evidence,
    })),
  };
}

const CATEGORIES: ReadonlySet<string> = new Set(["happy", "edge", "error"]);

/** 导入时只校验过锚点的形状；这里再按合并入口的口径收一遍，形状不对就报错回滚，不悄悄丢。 */
function anchorsOf(scenario: DraftScenarioRow): AnalysisResult["features"][number]["scenarios"][number]["evidence"] {
  let parsed: unknown = scenario.evidence;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(`import draft scenario ${scenario.id} has unreadable evidence`);
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`import draft scenario ${scenario.id} has evidence that is not a list`);
  return parsed.map((item: unknown) => {
    const anchor = (typeof item === "object" && item !== null ? item : {}) as { path?: unknown; startLine?: unknown; endLine?: unknown };
    if (typeof anchor.path !== "string" || anchor.path === "") throw new Error(`import draft scenario ${scenario.id} has an evidence item without a path`);
    const line = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? { line: value } : null);
    const start = line(anchor.startLine);
    const end = line(anchor.endLine);
    return { path: anchor.path, ...(start ? { startLine: start.line } : {}), ...(end ? { endLine: end.line } : {}) };
  });
}

const BACKFILL_TEXT = {
  "zh-CN": {
    title: "首个账本版本（由导入的雷达快照回填）",
    summary: "这一版由导入的雷达快照回填而来：内容是租户在自己的机器上分析出来的，服务端没有为它读过源码，也没有调过模型。",
  },
  en: {
    title: "First ledger version (backfilled from an imported radar snapshot)",
    summary: "This version was backfilled from an imported radar snapshot: the content was produced on the tenant's own machine. The server read no source and called no model for it.",
  },
} as const;

/** 合并入口要的分析结果。产品简介留空：导入时写过的简介原样保留，这里不碰。 */
export function resultOf(rows: DraftRows, language: "zh-CN" | "en"): AnalysisResult {
  const text = BACKFILL_TEXT[language];
  const scenariosByFeature = new Map<number, AnalysisResult["features"][number]["scenarios"]>();
  for (const scenario of rows.scenarios) {
    if (!CATEGORIES.has(scenario.category)) throw new Error(`import draft scenario ${scenario.id} has category ${scenario.category}`);
    const list = scenariosByFeature.get(scenario.featureId) ?? [];
    list.push({
      reference: scenario.reference,
      context: scenario.context,
      action: scenario.action,
      outcome: scenario.outcome,
      category: scenario.category,
      ...(scenario.stepOrder === null ? {} : { step: scenario.stepOrder }),
      evidence: anchorsOf(scenario),
    });
    scenariosByFeature.set(scenario.featureId, list);
  }
  return {
    product: { description: "", evidence: [] },
    release: { title: text.title, summary: text.summary },
    changes: [],
    features: rows.features.map((feature) => ({ name: feature.name, summary: feature.summary, scenarios: scenariosByFeature.get(feature.id) ?? [] })),
  };
}

export function releaseUrlOf(repository: { provider: string; host: string | null; owner: string; name: string }, sha: string): string {
  const host = repository.host ?? (repository.provider === "github" ? GITHUB : null);
  return host === null ? "" : `https://${host}/${repository.owner}/${repository.name}/commit/${sha}`;
}

/** 回填出来的版本的来源信息。两组还是分开的：服务端这一组说清它做过的核对（没有），客户端那一组是空的，因为导入什么都没记。 */
export interface ImportBackfillProvenance {
  server: {
    executor: "client";
    entry: "import_backfill";
    backfilledAt: string;
    importedAt: string | null;
    specVersionId: number;
    revisionSha: string;
    contractVersion: string;
    verification: { scope: "none"; reanalyzed: 0; deterministicallyCarried: 0; clientDeclaredUnaffected: 0 };
  };
  client: null;
}

export function backfillProvenance(
  candidate: DraftBackfillCandidate,
  server: { specVersionId: number; backfilledAt: string },
): ImportBackfillProvenance {
  return {
    server: {
      executor: "client",
      entry: "import_backfill",
      backfilledAt: server.backfilledAt,
      importedAt: candidate.seeded.importedAt ? candidate.seeded.importedAt.toISOString() : null,
      specVersionId: server.specVersionId,
      revisionSha: candidate.seeded.snapshotSha as string,
      contractVersion: candidate.seeded.contractVersion as string,
      verification: { scope: "none", reanalyzed: 0, deterministicallyCarried: 0, clientDeclaredUnaffected: 0 },
    },
    client: null,
  };
}

export interface BackfillOptions {
  /** 那个提交的提交时间（ISO 8601）。服务端不知道它，所以必须给。 */
  committedAt: string;
  currentContractVersion: string;
  /** 明知导入时的契约和现在的不一样，仍然回填。 */
  acceptContractDrift?: boolean;
  /** 明知合并入口会去掉完全重复的草稿场景，仍然回填。 */
  acceptDedupe?: boolean;
  now?: () => Date;
}

interface BackfillOutcome {
  productId: number;
  repositoryId: number;
  runId: number;
  specVersionId: number;
  releaseId: number;
  revisionSha: string;
  /** 发布上登记的提交时间，就是调用方给的那个。 */
  committedAt: string;
  draft: { features: number; scenarios: number; withoutEvidence: number };
  version: { features: number; scenarios: number; manualFeatures: number; manualScenarios: number };
  /** 发布页上会列出的条目数。首个版本把每个功能都列为「新增」。 */
  releaseChanges: number;
  /** 进不了版本的草稿场景：和另一条文字、证据路径都完全一样，被合并入口去重了。 */
  droppedDraft: Array<{ feature: string; reference: string }>;
}

export interface ImportBackfillReceipt extends BackfillOutcome {
  /** true 表示事务已经回滚，库里什么都没变。 */
  dryRun: boolean;
}

const executeOf = (connection: PoolConnection): Execute => (statement, parameters) => connection.execute(statement, parameters);

function assertCommittedAt(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`--committed-at is not a date: ${value}`);
  return date;
}

/**
 * 回填的事务体，写给已经拿着连接的调用方。这里不开事务、不提交、不回滚。
 * 任何一步失败都抛错，由调用方回滚——包括来源标记的改动。
 */
export async function backfillDraftInTransaction(connection: PoolConnection, target: BackfillTarget, options: BackfillOptions): Promise<BackfillOutcome> {
  const committedAt = assertCommittedAt(options.committedAt);
  // 事务的第一条语句是锁定读：拿到锁之后再读条件，读到的一定是最新提交的事实。
  const locked = rowsOf(await connection.execute("SELECT id FROM products WHERE organization_id = ? AND slug = ? FOR UPDATE", [target.organizationId, target.slug]));
  const productId = locked[0] ? Number(locked[0].id) : null;
  if (productId !== null) await connection.execute("SELECT id FROM repositories WHERE product_id = ? FOR UPDATE", [productId]);
  const execute = executeOf(connection);
  const candidate = productId === null ? null : await loadBackfillCandidate(execute, target);
  const blockages = candidate ? blockagesOf(candidate, { currentContractVersion: options.currentContractVersion, acceptContractDrift: options.acceptContractDrift === true }) : [{ code: "product_not_found" as const, detail: `组织 ${target.organizationId} 里没有叫 ${target.slug} 的产品` }];
  if (blockages.length > 0 || !candidate || !candidate.repository || !candidate.seeded.snapshotSha) throw new ImportBackfillRefused(blockages);

  const rows = await loadDraftRows(execute, candidate.productId);
  const result = resultOf(rows, candidate.outputLanguage);

  // 来源改成 generated，行号不变。之后的合并入口才会更新这些行。
  const [convertedFeatures] = (await connection.execute("UPDATE features SET source = 'generated' WHERE product_id = ? AND source = ?", [candidate.productId, IMPORT_SOURCE])) as [{ affectedRows?: number }, unknown];
  const [convertedScenarios] = (await connection.execute("UPDATE scenarios s JOIN features f ON f.id = s.feature_id SET s.source = 'generated' WHERE f.product_id = ? AND s.source = ?", [candidate.productId, IMPORT_SOURCE])) as [{ affectedRows?: number }, unknown];
  const draftFeatures = candidate.workbench.features[`${IMPORT_SOURCE}:active`] ?? 0;
  const draftScenarios = candidate.workbench.scenarios[`${IMPORT_SOURCE}:active`] ?? 0;
  if (Number(convertedFeatures?.affectedRows) !== draftFeatures || Number(convertedScenarios?.affectedRows) !== draftScenarios) {
    throw new Error(`the draft changed while it was being read: expected ${draftFeatures} features and ${draftScenarios} scenarios, converted ${String(convertedFeatures?.affectedRows)} and ${String(convertedScenarios?.affectedRows)}`);
  }

  const [inserted] = (await connection.execute(
    "INSERT INTO analysis_runs (repository_id, trigger_type, before_sha, after_sha, status, account_id) VALUES (?, ?, NULL, ?, 'running', ?)",
    [candidate.repository.id, IMPORT_BACKFILL_TRIGGER, candidate.seeded.snapshotSha, candidate.organizationId],
  )) as unknown as [{ insertId: number }, unknown];
  const run: RunContext = {
    id: Number(inserted.insertId),
    repositoryId: candidate.repository.id,
    productId: candidate.productId,
    organizationId: candidate.organizationId,
    productSlug: candidate.slug,
    productName: candidate.productName,
    owner: candidate.repository.owner,
    name: candidate.repository.name,
    provider: candidate.repository.provider as CodeHostingProvider,
    connectionId: null,
    accountId: candidate.organizationId,
    analyzeMode: "full",
    outputLanguage: candidate.outputLanguage,
    beforeSha: null,
    afterSha: candidate.seeded.snapshotSha,
    baseSpecVersionId: null,
    baseCapturedAt: null,
    triggerType: IMPORT_BACKFILL_TRIGGER,
    analysisExecutor: "client",
  };
  // 变更窗口是空的：服务端不知道那次快照看过哪些文件，不编一份。
  const change = { message: result.release.title, committedAt: committedAt.toISOString(), url: releaseUrlOf(candidate.repository, candidate.seeded.snapshotSha), files: [] };
  const saved = await saveResultInTransaction(connection, run, result, change, null, undefined);
  if (!saved.activate) throw new Error("an import backfill must be the latest run of its repository");

  const provenance = backfillProvenance(candidate, { specVersionId: saved.specVersionId, backfilledAt: (options.now ?? (() => new Date()))().toISOString() });
  await connection.execute("UPDATE spec_versions SET provenance_json = ? WHERE id = ?", [JSON.stringify(provenance), saved.specVersionId]);

  const versionRows = rowsOf(await connection.execute(
    "SELECT f.name, s.reference, s.source FROM spec_scenarios s JOIN spec_features f ON f.id = s.spec_feature_id WHERE f.spec_version_id = ?",
    [saved.specVersionId],
  ));
  const versionPairs = new Set(versionRows.map((row) => `${row.name}\u0000${row.reference}`));
  const featureById = new Map(rows.features.map((feature) => [feature.id, feature.name]));
  const droppedDraft: Array<{ feature: string; reference: string }> = [];
  for (const scenario of rows.scenarios) {
    if (!versionPairs.has(`${featureById.get(scenario.featureId) ?? ""}\u0000${scenario.reference}`)) {
      droppedDraft.push({ feature: featureById.get(scenario.featureId) ?? "", reference: scenario.reference });
    }
  }
  const versionFeatureRows = rowsOf(await connection.execute("SELECT source, COUNT(*) AS count FROM spec_features WHERE spec_version_id = ? GROUP BY source", [saved.specVersionId]));
  return {
    productId: candidate.productId,
    repositoryId: candidate.repository.id,
    runId: run.id,
    specVersionId: saved.specVersionId,
    releaseId: saved.releaseId,
    revisionSha: candidate.seeded.snapshotSha,
    committedAt: committedAt.toISOString(),
    draft: { features: rows.features.length, scenarios: rows.scenarios.length, withoutEvidence: result.features.reduce((sum, feature) => sum + feature.scenarios.filter((scenario) => scenario.evidence.length === 0).length, 0) },
    version: {
      features: versionFeatureRows.reduce((sum, row) => sum + Number(row.count), 0),
      scenarios: versionRows.length,
      manualFeatures: Number(versionFeatureRows.find((row) => row.source === "manual")?.count ?? 0),
      manualScenarios: versionRows.filter((row) => row.source === "manual").length,
    },
    releaseChanges: saved.releaseChangeProjections.length,
    droppedDraft,
  };
}

/**
 * 演练或写入。两种都是先在事务里真做一遍；演练到这里回滚，写入才提交。
 * 写入时如果有草稿场景会被去重而调用方没有明确接受，同样回滚并拒绝——去重会让那些行从工作台上消失，
 * 这件事要有人看过演练报告之后点头。
 */
export async function backfillImportDraft(pool: Pick<Pool, "getConnection">, target: BackfillTarget, options: BackfillOptions & { apply: boolean }): Promise<ImportBackfillReceipt> {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    let outcome: BackfillOutcome;
    try {
      outcome = await backfillDraftInTransaction(connection, target, options);
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    // 会被去重的草稿场景：演练照样报告出来，写入则要调用方明确接受。
    const unaccepted = outcome.droppedDraft.length > 0 && options.acceptDedupe !== true;
    if (options.apply && !unaccepted) await connection.commit();
    else await connection.rollback();
    if (unaccepted && options.apply) {
      throw new ImportBackfillRefused([{ code: "draft_duplicates", detail: `${outcome.droppedDraft.length} 条草稿场景和另一条完全重复，回填会把它们去掉；看过演练报告后用 --accept-dedupe 确认` }]);
    }
    return { ...outcome, dryRun: !options.apply };
  } finally {
    connection.release();
  }
}
