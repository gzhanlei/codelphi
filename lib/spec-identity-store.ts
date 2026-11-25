import type { Execute } from "./db";
import { specIdentityLayerEnabled } from "./env";
import { specFeatureKey } from "./spec-diff";
import {
  changeRowIdentity,
  emptyIdentityMaps,
  planVersionIdentities,
  restoredFeatures,
  restoredScenarios,
  type IdentityFeatureInput,
  type IdentityRegistry,
  type IdentitySources,
  type MutableIdentityMaps,
  type VersionIdentities,
  type VersionIdentityPlan,
} from "./spec-identity";

/**
 * 身份层的读写（规格 §20）。写入路径（每次发布）和回填脚本共用这里的语句，两边写出来的登记表是同一个形状。
 *
 * 身份列是 utf8mb4_bin，名称列是 utf8mb4_0900_ai_ci。这里的语句从不把两种列放在一起比较：
 * 名称到身份的解析都在内存里做完，SQL 只按主键写、按身份列查身份表。
 */

type Row = Record<string, unknown>;

/** mysql2 的 execute 返回 [rows, fields]；测试里的替身可能返回 [{}]。两种都只取出真正的行。 */
export function resultRows(result: unknown): Row[] {
  const payload = Array.isArray(result) ? result[0] : result;
  return Array.isArray(payload) ? (payload as Row[]) : [];
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * 把查出来的行装成映射。功能行带 nameKey 和 identity_key，场景行带 featureIdentityKey、reference 和 identity_key。
 * 有一列不是字符串的行跳过：身份层之前写入的版本身份列是空的。读取路径不按名称补猜，空就是空。
 */
function identityMapsOf(featureRows: readonly Row[], scenarioRows: readonly Row[]): MutableIdentityMaps {
  const maps = emptyIdentityMaps();
  for (const row of featureRows) {
    const nameKey = text(row.nameKey);
    const identityKey = text(row.identity_key);
    if (nameKey !== null && identityKey !== null) maps.features.set(nameKey, identityKey);
  }
  for (const row of scenarioRows) {
    const featureIdentityKey = text(row.featureIdentityKey);
    const reference = text(row.reference);
    const identityKey = text(row.identity_key);
    if (featureIdentityKey === null || reference === null || identityKey === null) continue;
    const references = maps.scenarios.get(featureIdentityKey) ?? new Map<string, string>();
    references.set(reference, identityKey);
    maps.scenarios.set(featureIdentityKey, references);
  }
  return maps;
}

/** 产品级的身份登记表：这条版本链上出现过的全部名称键和场景身份。 */
export async function loadIdentityRegistry(productId: number, execute: Execute): Promise<IdentityRegistry> {
  const [featureResult, scenarioResult] = await Promise.all([
    // 功能身份键就是它首次出现时的名称键，所以名称键和身份键查的是同一列。
    execute("SELECT identity_key AS nameKey, identity_key FROM feature_identities WHERE product_id = ?", [productId]),
    execute("SELECT feature_identity_key AS featureIdentityKey, reference, identity_key FROM scenario_identities WHERE product_id = ?", [productId]),
  ]);
  return identityMapsOf(resultRows(featureResult), resultRows(scenarioResult));
}

/**
 * 批量读取多个版本的身份，key 是版本号。每个版本两条查询，不分版本逐个读。
 * 身份层之前写入的版本、或者开关关着时写入的版本，身份列是空的，这样的版本读出来是空映射。
 */
export async function loadVersionIdentityMaps(execute: Execute, versionIds: readonly number[]): Promise<Map<number, VersionIdentities>> {
  const maps = new Map<number, VersionIdentities>();
  if (versionIds.length === 0) return maps;
  const placeholders = versionIds.map(() => "?").join(",");
  const [featureResult, scenarioResult] = await Promise.all([
    execute(`SELECT spec_version_id AS versionId, stable_key AS nameKey, identity_key FROM spec_features WHERE spec_version_id IN (${placeholders})`, [...versionIds]),
    execute(
      `SELECT sf.spec_version_id AS versionId, sf.identity_key AS featureIdentityKey, ss.reference, ss.identity_key
       FROM spec_scenarios ss JOIN spec_features sf ON sf.id = ss.spec_feature_id WHERE sf.spec_version_id IN (${placeholders})`,
      [...versionIds],
    ),
  ]);
  const featuresByVersion = groupRowsByVersion(resultRows(featureResult));
  const scenariosByVersion = groupRowsByVersion(resultRows(scenarioResult));
  for (const versionId of versionIds) {
    maps.set(versionId, identityMapsOf(featuresByVersion.get(versionId) ?? [], scenariosByVersion.get(versionId) ?? []));
  }
  return maps;
}

function groupRowsByVersion(rows: readonly Row[]): Map<number, Row[]> {
  const grouped = new Map<number, Row[]>();
  for (const row of rows) {
    const list = grouped.get(Number(row.versionId));
    if (list) list.push(row);
    else grouped.set(Number(row.versionId), [row]);
  }
  return grouped;
}

/** 一个版本已经落库的身份。 */
export async function loadVersionIdentities(versionId: number, execute: Execute): Promise<VersionIdentities> {
  return (await loadVersionIdentityMaps(execute, [versionId])).get(versionId) ?? emptyIdentityMaps();
}

/**
 * 给一个版本算身份之前要对照的两份身份：产品级的登记表，和上一版的身份（首版没有上一版，传 null）。
 * 身份层开关（SPEC_IDENTITY_LAYER）关着时返回 null，什么都不读：调用方照常写版本，身份列留空。
 */
export async function loadIdentitySources(productId: number, baseVersionId: number | null, execute: Execute): Promise<IdentitySources | null> {
  if (!specIdentityLayerEnabled()) return null;
  const [registry, previous] = await Promise.all([
    loadIdentityRegistry(productId, execute),
    baseVersionId === null ? Promise.resolve(emptyIdentityMaps()) : loadVersionIdentities(baseVersionId, execute),
  ]);
  return { previous, registry };
}

export interface IdentityAssignment {
  id: number;
  /** 与 columns 一一对应。 */
  values: Array<string | null>;
}

/** 一条批量语句最多带这么多行，语句大小和参数个数都留有余量。 */
export const ASSIGN_CHUNK_SIZE = 400;

/**
 * 按主键批量赋值的语句：把要写的行拼成一张派生表，再和目标表按主键连上更新。
 * 不用临时表，事务里建临时表在有些二进制日志配置下不允许。
 */
export function bulkAssignSql(table: string, columns: readonly string[], rows: readonly IdentityAssignment[]): { sql: string; params: Array<string | number | null> } | null {
  if (rows.length === 0) return null;
  const width = columns.length + 1;
  // 参数显式定型：主键转成无符号整数，连接才能走主键索引（不转的话参数可能被当成浮点数）；身份键转成字符。
  const first = `SELECT CAST(? AS UNSIGNED) AS id${columns.length === 0 ? "" : `, ${columns.map((column) => `CAST(? AS CHAR) AS ${column}`).join(", ")}`}`;
  const rest = rows.slice(1).map(() => `UNION ALL SELECT ${Array(width).fill("?").join(", ")}`).join(" ");
  const params: Array<string | number | null> = [];
  for (const row of rows) params.push(row.id, ...row.values);
  return {
    sql: `UPDATE \`${table}\` AS t JOIN (${[first, rest].filter(Boolean).join(" ")}) AS src ON src.id = t.id SET ${columns.map((column) => `t.${column} = src.${column}`).join(", ")}`,
    params,
  };
}

async function assignRows(execute: Execute, table: string, columns: readonly string[], rows: readonly IdentityAssignment[]): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += ASSIGN_CHUNK_SIZE) {
    const built = bulkAssignSql(table, columns, rows.slice(offset, offset + ASSIGN_CHUNK_SIZE));
    if (built) await execute(built.sql, built.params);
  }
}

async function inChunks<T>(items: readonly T[], run: (chunk: T[]) => Promise<void>): Promise<void> {
  for (let offset = 0; offset < items.length; offset += ASSIGN_CHUNK_SIZE) await run(items.slice(offset, offset + ASSIGN_CHUNK_SIZE));
}

type IdentityTable = "feature_identities" | "scenario_identities";

/** 登记表的列。每行写入的值是 [product_id, ...这个身份自己的几项, 首次出现的版本]，和这里的列一一对应。 */
const IDENTITY_COLUMNS: Record<IdentityTable, readonly string[]> = {
  feature_identities: ["product_id", "identity_key", "first_name", "first_spec_version_id"],
  scenario_identities: ["product_id", "identity_key", "feature_identity_key", "reference", "first_spec_version_id"],
};

async function insertMinted(table: IdentityTable, productId: number, specVersionId: number, rows: ReadonlyArray<string[]>, execute: Execute): Promise<void> {
  const columns = IDENTITY_COLUMNS[table];
  await inChunks(rows, async (chunk) => {
    // 占位符的个数直接取自列清单，不和参数各算各的。两边对不上时数据库会报列数与值数不一致。
    const row = `(${columns.map(() => "?").join(", ")})`;
    const placeholders = chunk.map(() => row).join(", ");
    const parameters = chunk.flatMap((values) => [productId, ...values, specVersionId]);
    // 同一个身份已经登记过时（重复运行，或者别的仓库先写下它）这一行不重建，只把“首次出现的版本”往前修：
    // 部署之后、回填之前发布过几次的话，登记表里记的是那次发布的版本，回填走到更早的版本时把它改成真正最早的。
    // 用 ON DUPLICATE KEY 而不是 INSERT IGNORE：后者会把别的错误也降成警告吞掉。
    await execute(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders} ON DUPLICATE KEY UPDATE first_spec_version_id = LEAST(first_spec_version_id, VALUES(first_spec_version_id))`,
      parameters,
    );
  });
}

async function insertLinks(table: "feature_identity_links" | "scenario_identity_links", productId: number, specVersionId: number, kind: "retire" | "restore", identityKeys: readonly string[], execute: Execute): Promise<void> {
  await inChunks(identityKeys, async (chunk) => {
    const placeholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    await execute(`INSERT IGNORE INTO ${table} (product_id, spec_version_id, kind, from_identity_key) VALUES ${placeholders}`, chunk.flatMap((identityKey) => [productId, specVersionId, kind, identityKey]));
  });
}

/**
 * 把一个版本的身份计划记进登记表：新建的身份插入，退休和恢复各记一条关系。
 * 登记表只追加：已有的行不删、不记状态，最多把“首次出现的版本”往更早改。
 * 某个身份现在在不在链上，看版本行的身份列，不看这里。
 * 必须在写入这个版本的同一个事务里调用。
 */
export async function recordIdentityPlan(productId: number, specVersionId: number, plan: VersionIdentityPlan, execute: Execute): Promise<void> {
  if (plan.minted.features.length > 0) await insertMinted("feature_identities", productId, specVersionId, plan.minted.features.map((feature) => [feature.identityKey, feature.firstName]), execute);
  if (plan.minted.scenarios.length > 0) {
    await insertMinted("scenario_identities", productId, specVersionId, plan.minted.scenarios.map((scenario) => [scenario.identityKey, scenario.featureIdentityKey, scenario.reference]), execute);
  }
  if (plan.retired.features.length > 0) await insertLinks("feature_identity_links", productId, specVersionId, "retire", plan.retired.features, execute);
  if (plan.retired.scenarios.length > 0) await insertLinks("scenario_identity_links", productId, specVersionId, "retire", plan.retired.scenarios.map((scenario) => scenario.identityKey), execute);
  const restoredFeatureIdentities = restoredFeatures(plan);
  const restoredScenarioIdentities = restoredScenarios(plan);
  if (restoredFeatureIdentities.length > 0) await insertLinks("feature_identity_links", productId, specVersionId, "restore", restoredFeatureIdentities, execute);
  if (restoredScenarioIdentities.length > 0) await insertLinks("scenario_identity_links", productId, specVersionId, "restore", restoredScenarioIdentities, execute);
}

/** 回填时一个版本里要补身份的行：只带定位和分配身份需要的列。 */
export interface IdentityRows {
  features: ReadonlyArray<{ id: number; name: string; parentKey: string | null }>;
  scenarios: ReadonlyArray<{ id: number; featureId: number; reference: string }>;
  changes: ReadonlyArray<{ id: number; featureKey: string; scenarioReference: string }>;
}

/** 把一个版本的行整理成身份分配的输入：场景按所属功能归拢。不属于本版任何功能的场景行不参与分配。 */
export function identityInputsOf(rows: Pick<IdentityRows, "features" | "scenarios">): IdentityFeatureInput[] {
  const referencesByFeature = new Map<number, string[]>();
  for (const scenario of rows.scenarios) {
    const references = referencesByFeature.get(scenario.featureId);
    if (references) references.push(scenario.reference);
    else referencesByFeature.set(scenario.featureId, [scenario.reference]);
  }
  return rows.features.map((feature) => ({ name: feature.name, parentKey: feature.parentKey, references: referencesByFeature.get(feature.id) ?? [] }));
}

/**
 * 回填用的写入：给一个已经落库的版本补上身份列，并把身份计划记进登记表。
 * 身份按规则算出来，和发布时写入路径算出来的完全一样。
 */
export async function assignVersionIdentities(
  productId: number,
  specVersionId: number,
  rows: IdentityRows,
  previous: VersionIdentities,
  execute: Execute,
  registry: IdentityRegistry = emptyIdentityMaps(),
): Promise<VersionIdentityPlan> {
  const plan = planVersionIdentities({ features: identityInputsOf(rows), previous, registry });
  const planByFeatureId = new Map(rows.features.map((feature) => [feature.id, plan.features.get(specFeatureKey(feature.name))] as const));
  await assignRows(execute, "spec_features", ["identity_key", "parent_identity_key"], rows.features.flatMap((feature) => {
    const assigned = planByFeatureId.get(feature.id);
    return assigned ? [{ id: feature.id, values: [assigned.identityKey, assigned.parentIdentityKey] }] : [];
  }));
  await assignRows(execute, "spec_scenarios", ["identity_key"], rows.scenarios.flatMap((scenario) => {
    const assigned = planByFeatureId.get(scenario.featureId)?.scenarios.get(scenario.reference);
    return assigned ? [{ id: scenario.id, values: [assigned.identityKey] }] : [];
  }));
  await assignRows(execute, "spec_changes", ["feature_identity_key", "scenario_identity_key"], rows.changes.flatMap((change) => {
    const identity = changeRowIdentity(change, plan, previous, registry);
    return identity.featureIdentityKey === null && identity.scenarioIdentityKey === null ? [] : [{ id: change.id, values: [identity.featureIdentityKey, identity.scenarioIdentityKey] }];
  }));
  await recordIdentityPlan(productId, specVersionId, plan, execute);
  return plan;
}
