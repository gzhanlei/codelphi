/**
 * 身份层的真实 MySQL 演练：在一个空的临时库里把上线要走的每一步都走一遍，每一步都用生产会用的入口。
 *
 *   1. 仓库自己的迁移入口从零建表（scripts/migrate.ts，001 起的全部迁移）；
 *   2. 灌入导出的账本（verify-spec-identity.ts 读的同一种导出）；
 *   3. 回填先演练、再写入：库里每一行的身份都和按规则离线算出来的一样。再写一遍，一行都不变；
 *      登记表里一个被改晚了的「首次出现的版本」会被改回真正最早的；
 *   4. 用真正的发布写入路径发两个版本（insertSpecVersion + upsertGeneratedSpec），核对写出来的行：
 *      两个版本之间把一个功能人工关掉，它不能再回到版本里；工作台行上已有的身份不被后来写入的覆盖；
 *   5. 回填再写一遍，第 4 步的仓库一行都不变。
 *   6. 把第 4 步再走一遍，这回功能在上一版里改过名（只有按身份才拦得住）。
 *
 * 第 6 步放在回填之后：它的数据里有一行身份和名称键不同，这只有客户端协议才会写出来。
 * 回填按名称键从头重算，会把它改回去——等有了那样的数据，就不能再对那些仓库跑回填。
 *
 * 只接受库名以 codelphi_test_spec_identity 开头的库，每次运行都先删掉重建；绝不默认连接 DATABASE_URL。
 * 它自己和它启动的子进程都不走 TLS：连接生产时的 TLS 设置不在这里验证。
 * 导出里没有的列（场景证据、变化摘要）灌成空值，回填和发布写入都不读它们。
 *
 * 用法（在仓库根目录）：
 *   SPEC_IDENTITY_VERIFY_DATABASE_URL="mysql://user:pass@127.0.0.1:3306/codelphi_test_spec_identity" \
 *     npx tsx scripts/verify-spec-identity-mysql.ts --ledger artifacts/spec-identity-verification/ledger-full.jsonl [--keep] [--md5-stand-in]
 *
 * --md5-stand-in：迁移 049 用了 MD5()，MySQL 9 起没有这个函数（生产是 MySQL 8）。加了这个开关，
 * 脚本在临时库里建一个同名的替身，只为让迁移链在这类版本上走完。
 */
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import mysql, { type Connection, type Pool, type PoolConnection } from "mysql2/promise";
import { type RunContext, upsertGeneratedSpec } from "../lib/analysis";
import { type AnalysisResult } from "../lib/ai";
import { databaseConfig } from "../lib/database-config";
import { specFeatureKey } from "../lib/spec-diff";
import {
  changeRowIdentity,
  emptyIdentityMaps,
  foldRegistry,
  type IdentityRegistry,
  planVersionIdentities,
  restoredFeatures,
  restoredScenarios,
  scenarioIdentityKey,
  toVersionIdentities,
  type VersionIdentities,
  type VersionIdentityPlan,
} from "../lib/spec-identity";
import { identityInputsOf, loadVersionIdentityMaps } from "../lib/spec-identity-store";
import { insertSpecVersion } from "../lib/spec-versions";
import { type ExportedVersion, identityRowsOf, parseLedgerExport } from "./verify-spec-identity";

const SCRATCH_PREFIX = "codelphi_test_spec_identity";
const ENV_URL = "SPEC_IDENTITY_VERIFY_DATABASE_URL";
const TABLES = ["features", "scenarios", "changes"] as const;
const SAMPLE_LIMIT = 5;

/** 一张表里的身份列：行号 → 这一行各个身份列的值。 */
export type RowIdentities = ReadonlyMap<number, readonly (string | null)[]>;

export interface VersionRows {
  features: RowIdentities;
  scenarios: RowIdentities;
  changes: RowIdentities;
}

/** 逐行核对用的全貌：版本行上的身份、登记表、关系表。 */
export interface LedgerState {
  versions: ReadonlyMap<number, VersionRows>;
  registry: ReadonlySet<string>;
  links: ReadonlySet<string>;
}

export interface VerifyOptions {
  url: string;
  ledgerPath: string;
  keep: boolean;
  md5StandIn: boolean;
}

type Row = Record<string, unknown>;

/** 从连接地址里取出库名，并确认它是一个可以随便删了重建的临时库。 */
export function scratchDatabase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${ENV_URL} 不是合法的连接地址`);
  }
  const name = parsed.pathname.replace(/^\//, "");
  if (parsed.protocol !== "mysql:" || !name.startsWith(SCRATCH_PREFIX) || !/^[0-9a-z_]*$/.test(name.slice(SCRATCH_PREFIX.length))) {
    throw new Error(`拒绝：这个脚本会删掉并重建它指向的库，库名必须以 ${SCRATCH_PREFIX} 开头（收到的是「${name}」）`);
  }
  return name;
}

export function parseArgs(argv: readonly string[]): Pick<VerifyOptions, "ledgerPath" | "keep" | "md5StandIn"> {
  const options = { ledgerPath: "", keep: false, md5StandIn: false };
  const usage = "用法：--ledger <导出文件> [--keep] [--md5-stand-in]";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ledger") options.ledgerPath = argv[++index];
    else if (argument === "--keep") options.keep = true;
    else if (argument === "--md5-stand-in") options.md5StandIn = true;
    else throw new Error(`${usage}；不认识「${argument}」`);
  }
  if (!options.ledgerPath) throw new Error(`${usage}；--ledger 必须给`);
  return options;
}

/** 每个仓库的版本链，按版本号排好。仓库的顺序就是回填处理它们的顺序。 */
export function chainsOf(versions: readonly ExportedVersion[]): Map<number, ExportedVersion[]> {
  const chains = new Map<number, ExportedVersion[]>();
  for (const version of versions) chains.set(version.repositoryId, [...(chains.get(version.repositoryId) ?? []), version]);
  for (const chain of chains.values()) chain.sort((a, b) => a.id - b.id);
  return chains;
}

function expectedFeatureRows(version: ExportedVersion, plan: VersionIdentityPlan): RowIdentities {
  // 计划里的功能和输入的行一一对应、顺序相同，按位置对应。
  const planned = [...plan.features.values()];
  return new Map(version.features.map((feature, index) => [feature.id, [planned[index].identityKey, planned[index].parentIdentityKey]]));
}

function expectedScenarioRows(version: ExportedVersion, plan: VersionIdentityPlan): RowIdentities {
  const planned = [...plan.features.values()];
  const byId = new Map(version.features.map((feature, index) => [feature.id, planned[index]]));
  // 规则没给这个编号身份时，回填也不给这一行写身份，库里保持为空。两边一致。
  return new Map(version.scenarios.map((scenario) => [scenario.id, [byId.get(scenario.featureId)?.scenarios.get(scenario.reference)?.identityKey ?? null]]));
}

function expectedChangeRows(version: ExportedVersion, plan: VersionIdentityPlan, previous: VersionIdentities, registry: IdentityRegistry): RowIdentities {
  return new Map(
    version.changes.map((change) => {
      const identity = changeRowIdentity(change, plan, previous, registry);
      return [change.id, [identity.featureIdentityKey, identity.scenarioIdentityKey]];
    }),
  );
}

function addRegistryRows(registry: Set<string>, version: ExportedVersion, plan: VersionIdentityPlan): void {
  for (const feature of plan.minted.features) registry.add(JSON.stringify(["feature_identities", version.productId, feature.identityKey, feature.firstName, version.id]));
  for (const scenario of plan.minted.scenarios) registry.add(JSON.stringify(["scenario_identities", version.productId, scenario.identityKey, scenario.featureIdentityKey, scenario.reference, version.id]));
}

function addLinks(links: Set<string>, versionId: number, kind: string, table: string, identityKeys: readonly string[]): void {
  for (const identityKey of identityKeys) links.add(JSON.stringify([table, versionId, kind, identityKey]));
}

/**
 * 沿着版本链按规则算出每一行的身份，以及登记表和关系表因此应该有的行。和回填用的是同一条规则，只是不写库。
 * 登记表按产品共用，所以仓库按号从小到大走，和回填处理的顺序一样。
 */
export function expectedState(chains: ReadonlyMap<number, readonly ExportedVersion[]>): LedgerState {
  const versions = new Map<number, VersionRows>();
  const registryRows = new Set<string>();
  const links = new Set<string>();
  const registries = new Map<number, IdentityRegistry>();
  for (const repositoryId of [...chains.keys()].sort((a, b) => a - b)) {
    let previous: VersionIdentities = emptyIdentityMaps();
    for (const version of chains.get(repositoryId) ?? []) {
      const registry = registries.get(version.productId) ?? emptyIdentityMaps();
      const plan = planVersionIdentities({ features: identityInputsOf(identityRowsOf(version)), previous, registry });
      versions.set(version.id, {
        features: expectedFeatureRows(version, plan),
        scenarios: expectedScenarioRows(version, plan),
        changes: expectedChangeRows(version, plan, previous, registry),
      });
      addRegistryRows(registryRows, version, plan);
      addLinks(links, version.id, "retire", "feature_identity_links", plan.retired.features);
      addLinks(links, version.id, "retire", "scenario_identity_links", plan.retired.scenarios.map((scenario) => scenario.identityKey));
      addLinks(links, version.id, "restore", "feature_identity_links", restoredFeatures(plan));
      addLinks(links, version.id, "restore", "scenario_identity_links", restoredScenarios(plan));
      registries.set(version.productId, foldRegistry(registry, plan));
      previous = toVersionIdentities(plan);
    }
  }
  return { versions, registry: registryRows, links };
}

const format = (values: readonly (string | null)[]): string => `[${values.map((value) => value ?? "").join(", ")}]`;

/** 逐行比较一张表里的身份列。一样时返回空数组。 */
export function diffIdentities(table: string, expected: RowIdentities, actual: RowIdentities, limit = SAMPLE_LIMIT): string[] {
  const differences: string[] = [];
  for (const [id, values] of expected) {
    const found = actual.get(id);
    if (found === undefined) differences.push(`${table} 行 ${id}：库里没有这一行`);
    else if (found.length !== values.length || values.some((value, index) => value !== found[index])) differences.push(`${table} 行 ${id}：应为 ${format(values)}，库里是 ${format(found)}`);
  }
  for (const [id, values] of actual) if (!expected.has(id)) differences.push(`${table} 行 ${id}：离线算出来这一行不该有身份，库里有 ${format(values)}`);
  return differences.slice(0, limit);
}

/** 比较两份行的清单（登记表、关系表、版本号）。 */
export function diffSets<T>(table: string, expected: ReadonlySet<T>, actual: ReadonlySet<T>, limit = SAMPLE_LIMIT): string[] {
  const differences = [
    ...[...expected].filter((row) => !actual.has(row)).map((row) => `${table}：缺 ${row}`),
    ...[...actual].filter((row) => !expected.has(row)).map((row) => `${table}：多 ${row}`),
  ];
  return differences.slice(0, limit);
}

/** 全貌比较，最多交出 limit 条。 */
export function diffStates(expected: LedgerState, actual: LedgerState, limit = SAMPLE_LIMIT): string[] {
  const differences = [...diffSets("版本", new Set(expected.versions.keys()), new Set(actual.versions.keys()), limit)];
  for (const [versionId, rows] of expected.versions) {
    const found = actual.versions.get(versionId);
    if (found) for (const table of TABLES) differences.push(...diffIdentities(`${table}（版本 ${versionId}）`, rows[table], found[table], limit));
  }
  return [...differences, ...diffSets("登记表", expected.registry, actual.registry, limit), ...diffSets("关系表", expected.links, actual.links, limit)].slice(0, limit);
}

// ---------- 以下都连数据库 ----------

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

async function rowsOf(target: Connection | Pool, statement: string, parameters: readonly unknown[] = []): Promise<Row[]> {
  const [rows] = await target.query(statement, [...parameters]);
  return rows as Row[];
}

function identitiesOf(rows: readonly Row[], columns: readonly string[]): RowIdentities {
  return new Map(rows.map((row) => [Number(row.id), columns.map((column) => text(row[column]))]));
}

/** 库里的全貌：每个版本三张表的行、登记表、关系表。 */
async function stateOf(pool: Pool): Promise<LedgerState> {
  const versions = new Map<number, VersionRows>();
  for (const row of await rowsOf(pool, "SELECT id FROM spec_versions ORDER BY id")) {
    const versionId = Number(row.id);
    const [features, scenarios, changes] = await Promise.all([
      rowsOf(pool, "SELECT id, identity_key AS identityKey, parent_identity_key AS parentIdentityKey FROM spec_features WHERE spec_version_id = ?", [versionId]),
      rowsOf(pool, "SELECT ss.id, ss.identity_key AS identityKey FROM spec_scenarios ss JOIN spec_features sf ON sf.id = ss.spec_feature_id WHERE sf.spec_version_id = ?", [versionId]),
      rowsOf(pool, "SELECT id, feature_identity_key AS featureIdentityKey, scenario_identity_key AS scenarioIdentityKey FROM spec_changes WHERE spec_version_id = ?", [versionId]),
    ]);
    versions.set(versionId, {
      features: identitiesOf(features, ["identityKey", "parentIdentityKey"]),
      scenarios: identitiesOf(scenarios, ["identityKey"]),
      changes: identitiesOf(changes, ["featureIdentityKey", "scenarioIdentityKey"]),
    });
  }
  const [featureRegistry, scenarioRegistry, links] = await Promise.all([
    rowsOf(pool, "SELECT product_id AS productId, identity_key AS identityKey, first_name AS firstName, first_spec_version_id AS firstVersionId FROM feature_identities"),
    rowsOf(pool, "SELECT product_id AS productId, identity_key AS identityKey, feature_identity_key AS featureIdentityKey, reference, first_spec_version_id AS firstVersionId FROM scenario_identities"),
    rowsOf(pool, "SELECT spec_version_id AS versionId, 'feature_identity_links' AS tableName, kind, from_identity_key AS fromIdentityKey FROM feature_identity_links UNION ALL SELECT spec_version_id, 'scenario_identity_links', kind, from_identity_key FROM scenario_identity_links"),
  ]);
  return {
    versions,
    registry: new Set([
      ...featureRegistry.map((row) => JSON.stringify(["feature_identities", Number(row.productId), row.identityKey, row.firstName, Number(row.firstVersionId)])),
      ...scenarioRegistry.map((row) => JSON.stringify(["scenario_identities", Number(row.productId), row.identityKey, row.featureIdentityKey, row.reference, Number(row.firstVersionId)])),
    ]),
    links: new Set(links.map((row) => JSON.stringify([row.tableName, Number(row.versionId), row.kind, row.fromIdentityKey]))),
  };
}

async function insertRows(connection: Connection, table: string, columns: readonly string[], rows: readonly (readonly unknown[])[], size = 200): Promise<void> {
  for (let start = 0; start < rows.length; start += size) {
    const chunk = rows.slice(start, start + size);
    const row = `(${columns.map(() => "?").join(", ")})`;
    await connection.query(`INSERT INTO \`${table}\` (${columns.join(", ")}) VALUES ${chunk.map(() => row).join(", ")}`, chunk.flat());
  }
}

/** 父表每个仓库只造最少的几行；行号用导出里的原值。 */
async function loadLedger(connection: Connection, versions: readonly ExportedVersion[]): Promise<void> {
  const repositories = [...new Map(versions.map((version) => [version.repositoryId, { repositoryId: version.repositoryId, productId: version.productId }])).values()];
  const products = [...new Set(repositories.map((repository) => repository.productId))];
  await insertRows(connection, "organizations", ["id", "slug", "name"], products.map((productId) => [productId, `verify-org-${productId}`, `Organization ${productId}`]));
  await insertRows(connection, "products", ["id", "slug", "name", "description", "organization_id"], products.map((productId) => [productId, `verify-product-${productId}`, `Product ${productId}`, "", productId]));
  await insertRows(connection, "repositories", ["id", "product_id", "owner", "name"], repositories.map((repository) => [repository.repositoryId, repository.productId, "verify", `repository-${repository.repositoryId}`]));
  await insertRows(connection, "analysis_runs", ["id", "repository_id", "trigger_type", "after_sha", "status"], versions.map((version) => [version.analysisRunId, version.repositoryId, "push", version.sha, "succeeded"]));
  await insertRows(
    connection,
    "spec_versions",
    ["id", "product_id", "repository_id", "analysis_run_id", "base_spec_version_id", "sha"],
    [...versions].sort((a, b) => a.id - b.id).map((version) => [version.id, version.productId, version.repositoryId, version.analysisRunId, version.baseSpecVersionId, version.sha]),
  );
  for (const version of versions) {
    await insertRows(
      connection,
      "spec_features",
      ["id", "spec_version_id", "stable_key", "name", "summary", "parent_key", "source", "position"],
      version.features.map((feature) => [feature.id, version.id, specFeatureKey(feature.name), feature.name, feature.summary, feature.parentKey, feature.source, feature.position]),
    );
    await insertRows(
      connection,
      "spec_scenarios",
      ["id", "spec_feature_id", "reference", "context", "action", "outcome", "category", "step_order", "source", "evidence"],
      version.scenarios.map((scenario) => [scenario.id, scenario.featureId, scenario.reference, scenario.context, scenario.action, scenario.outcome, scenario.category, scenario.step, scenario.source, "[]"]),
    );
    await insertRows(
      connection,
      "spec_changes",
      ["id", "spec_version_id", "entity_type", "kind", "feature_key", "feature_name", "scenario_reference", "base_spec_version_id", "summary"],
      version.changes.map((change) => [change.id, version.id, change.entityType, change.kind, change.featureKey, change.featureName, change.scenarioReference, change.baseSpecVersionId, ""]),
    );
  }
}

interface ScriptResult {
  code: number;
  output: string;
  seconds: number;
}

/** 用生产会用的方式启动仓库自己的脚本：入口、参数、环境变量都一样。 */
function runScript(script: string, args: readonly string[] = []): ScriptResult {
  const started = Date.now();
  const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { code: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, seconds: (Date.now() - started) / 1000 };
}

function mustSucceed(result: ScriptResult, what: string): ScriptResult {
  if (result.code !== 0) throw new Error(`${what}失败（退出码 ${result.code}）：\n${result.output.slice(-3000)}`);
  return result;
}

function mustBeEmpty(differences: readonly string[], what: string): void {
  if (differences.length > 0) throw new Error(`${what}：对不上（最多列 ${SAMPLE_LIMIT} 条）\n${differences.join("\n")}`);
}

function mustBe(ok: boolean, message: string, details: unknown): void {
  if (!ok) throw new Error(`${message}；实际是 ${JSON.stringify(details)}`);
}

async function inTransaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

interface Synthetic {
  organizationId: number;
  productId: number;
  repositoryId: number;
  firstRunId: number;
  secondRunId: number;
}

/** 合成仓库用的各个编号。表各算各的，故意不取一样的数。 */
const syntheticIds = (offset: number): Synthetic => ({ organizationId: 900_001 + offset, productId: 900_002 + offset, repositoryId: 900_003 + offset, firstRunId: 900_010 + offset, secondRunId: 900_011 + offset });

function syntheticRun(ids: Synthetic, id: number, beforeSha: string | null, afterSha: string): RunContext {
  return { id, repositoryId: ids.repositoryId, productId: ids.productId, owner: "verify", name: "spec-identity", beforeSha, afterSha, connectionId: null, provider: "github", organizationId: ids.organizationId, productSlug: `verify-spec-identity-${ids.productId}`, productName: "Verify spec identity" };
}

function publication(features: ReadonlyArray<readonly [string, string]>): AnalysisResult {
  return {
    product: { description: "Synthetic product for the identity rehearsal", evidence: [{ path: "lib/spec-identity.ts", startLine: 1 }] },
    release: { title: "Synthetic release", summary: "Synthetic" },
    changes: [],
    features: features.map(([name, outcome]) => ({ name, summary: `Summary of ${name}`, scenarios: [{ reference: "HP-1", context: "User", action: "Uses it", outcome, category: "happy" as const, evidence: [] }] })),
  };
}

/** 和 saveResult 写规格的那两步一样：先写版本行，再把合并后的规格投影到工作台。 */
async function publish(connection: PoolConnection, run: RunContext, result: AnalysisResult) {
  const saved = await insertSpecVersion(connection, run, result);
  await upsertGeneratedSpec(connection, run, saved.features, saved.identities ?? null);
  return saved;
}

const sorted = (values: readonly unknown[]): string[] => values.map(String).sort();

/**
 * 在一个合成仓库上发两个版本，核对写出来的行。两个版本之间用户把 Login 关掉；
 * renamed 为真时上一版里它已经改名叫 Legacy login，这时只有按身份才拦得住。
 */
async function publishTwice(pool: Pool, ids: Synthetic, renamed: boolean): Promise<{ lines: string[]; problems: string[] }> {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };
  const productId = ids.productId;
  const slug = `verify-spec-identity-${productId}`;
  await inTransaction(pool, async (connection) => {
    await insertRows(connection, "organizations", ["id", "slug", "name"], [[ids.organizationId, slug, "Verify spec identity"]]);
    await insertRows(connection, "products", ["id", "slug", "name", "description", "organization_id"], [[productId, slug, "Verify spec identity", "", ids.organizationId]]);
    await insertRows(connection, "repositories", ["id", "product_id", "owner", "name"], [[ids.repositoryId, productId, "verify", `spec-identity-${productId}`]]);
    await insertRows(connection, "analysis_runs", ["id", "repository_id", "trigger_type", "after_sha", "status"], [
      [ids.firstRunId, ids.repositoryId, "push", "a", "succeeded"],
      [ids.secondRunId, ids.repositoryId, "push", "b", "succeeded"],
    ]);
  });

  const first = await inTransaction(pool, (connection) => publish(connection, syntheticRun(ids, ids.firstRunId, null, "a"), publication([["Login", "Dashboard"], ["Export", "CSV"]])));
  const retiredScenario = scenarioIdentityKey("login", "HP-1");
  await inTransaction(pool, async (connection) => {
    if (renamed) {
      // 上一版是带着身份发布的：Login 改了名，身份没变。读上一版的身份用的是名称键（stable_key），两列一起改。
      await connection.execute("UPDATE spec_features SET name = 'Legacy login', stable_key = 'legacy login' WHERE spec_version_id = ? AND identity_key = 'login'", [first.specVersionId]);
    }
    // 用户在工作台把 Login 和它的 HP-1 关掉。工作台行上还是旧名字。
    await connection.execute("UPDATE features SET active = 0, source = 'manual' WHERE product_id = ? AND identity_key = 'login'", [productId]);
    await connection.execute("UPDATE scenarios s JOIN features f ON f.id = s.feature_id SET s.active = 0, s.source = 'manual' WHERE f.product_id = ? AND s.identity_key = ?", [productId, retiredScenario]);
  });
  const secondRun = syntheticRun(ids, ids.secondRunId, "a", "b");
  const second = await inTransaction(pool, (connection) => publish(connection, secondRun, publication([[renamed ? "Legacy login" : "Login", "Dashboard"], ["Export", "Parquet"], ["Import", "Rows"]])));

  const [secondFeatures, secondScenarios, changeRows, registryFeatures, registryScenarios, linkRows, workbenchFeatures, workbenchScenarios] = await Promise.all([
    rowsOf(pool, "SELECT name, identity_key AS identityKey FROM spec_features WHERE spec_version_id = ? ORDER BY id", [second.specVersionId]),
    rowsOf(pool, "SELECT ss.identity_key AS identityKey FROM spec_scenarios ss JOIN spec_features sf ON sf.id = ss.spec_feature_id WHERE sf.spec_version_id = ? ORDER BY ss.id", [second.specVersionId]),
    rowsOf(pool, "SELECT feature_identity_key AS featureIdentityKey, scenario_identity_key AS scenarioIdentityKey FROM spec_changes WHERE spec_version_id = ?", [second.specVersionId]),
    rowsOf(pool, "SELECT identity_key AS identityKey, first_spec_version_id AS firstVersionId FROM feature_identities WHERE product_id = ?", [productId]),
    rowsOf(pool, "SELECT identity_key AS identityKey, first_spec_version_id AS firstVersionId FROM scenario_identities WHERE product_id = ?", [productId]),
    rowsOf(pool, "SELECT 'feature_identity_links' AS tableName, kind, from_identity_key AS fromIdentityKey FROM feature_identity_links WHERE product_id = ? AND spec_version_id = ? UNION ALL SELECT 'scenario_identity_links', kind, from_identity_key FROM scenario_identity_links WHERE product_id = ? AND spec_version_id = ?", [productId, second.specVersionId, productId, second.specVersionId]),
    rowsOf(pool, "SELECT name, identity_key AS identityKey, active FROM features WHERE product_id = ? ORDER BY name", [productId]),
    rowsOf(pool, "SELECT s.identity_key AS identityKey FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE f.product_id = ? ORDER BY s.id", [productId]),
  ]);
  check(JSON.stringify(sorted(secondFeatures.map((row) => `${row.name}=${row.identityKey}`))) === JSON.stringify(["Export=export", "Import=import"]), `第二个版本的功能行：${JSON.stringify(secondFeatures)}`);
  check(JSON.stringify(sorted(secondScenarios.map((row) => row.identityKey))) === JSON.stringify(sorted([scenarioIdentityKey("export", "HP-1"), scenarioIdentityKey("import", "HP-1")])), `第二个版本的场景身份：${JSON.stringify(secondScenarios)}`);
  check(changeRows.length > 0 && changeRows.every((row) => row.featureIdentityKey !== null), `第二个版本的变化行有没有带身份的：${JSON.stringify(changeRows)}`);
  check(JSON.stringify(sorted(registryFeatures.map((row) => `${row.identityKey}@${row.firstVersionId}`))) === JSON.stringify(sorted(["login@" + first.specVersionId, "export@" + first.specVersionId, "import@" + second.specVersionId])), `功能登记表：${JSON.stringify(registryFeatures)}`);
  check(JSON.stringify(sorted(registryScenarios.map((row) => `${row.identityKey}@${row.firstVersionId}`))) === JSON.stringify(sorted([retiredScenario + "@" + first.specVersionId, scenarioIdentityKey("export", "HP-1") + "@" + first.specVersionId, scenarioIdentityKey("import", "HP-1") + "@" + second.specVersionId])), `场景登记表：${JSON.stringify(registryScenarios)}`);
  check(JSON.stringify(sorted(linkRows.map((row) => `${row.tableName}:${row.kind}:${row.fromIdentityKey}`))) === JSON.stringify(sorted([`feature_identity_links:retire:login`, `scenario_identity_links:retire:${retiredScenario}`])), `第二个版本的关系：${JSON.stringify(linkRows)}`);
  check(JSON.stringify(workbenchFeatures.map((row) => `${row.name}=${row.identityKey}=${row.active}`)) === JSON.stringify(["Export=export=1", "Import=import=1", "Login=login=0"]), `工作台的功能行：${JSON.stringify(workbenchFeatures)}`);
  check(JSON.stringify(sorted(workbenchScenarios.map((row) => row.identityKey))) === JSON.stringify(sorted([retiredScenario, scenarioIdentityKey("export", "HP-1"), scenarioIdentityKey("import", "HP-1")])), `工作台的场景身份：${JSON.stringify(workbenchScenarios)}`);

  const maps = await loadVersionIdentityMaps((statement, parameters) => pool.execute(statement, parameters), [first.specVersionId, second.specVersionId]);
  check(maps.get(second.specVersionId)?.features.get("import") === "import", `按身份批量读取：第二个版本的功能 ${JSON.stringify([...(maps.get(second.specVersionId)?.features ?? [])])}`);
  check(maps.get(second.specVersionId)?.scenarios.get("export")?.get("HP-1") === scenarioIdentityKey("export", "HP-1"), "按身份批量读取：第二个版本 Export 的 HP-1");

  // 行上已有身份时，后来写入的身份不覆盖它。
  const plan = second.identities;
  if (plan == null) throw new Error("身份层没有给出计划：检查 SPEC_IDENTITY_LAYER");
  const forged: VersionIdentityPlan = {
    ...plan,
    features: new Map([...plan.features].map(([key, feature]) => [key, key === "export" ? { ...feature, identityKey: "forged", scenarios: new Map([...feature.scenarios].map(([reference, scenario]) => [reference, { ...scenario, identityKey: "forged scenario" }])) } : feature])),
  };
  await inTransaction(pool, (connection) => upsertGeneratedSpec(connection, secondRun, second.features, forged));
  const [afterForgedFeatures, afterForgedScenarios] = await Promise.all([
    rowsOf(pool, "SELECT name, identity_key AS identityKey, active FROM features WHERE product_id = ? ORDER BY name", [productId]),
    rowsOf(pool, "SELECT s.identity_key AS identityKey FROM scenarios s JOIN features f ON f.id = s.feature_id WHERE f.product_id = ? ORDER BY s.id", [productId]),
  ]);
  check(JSON.stringify(afterForgedFeatures) === JSON.stringify(workbenchFeatures) && JSON.stringify(afterForgedScenarios) === JSON.stringify(workbenchScenarios), `带着另一份身份再投影一遍，工作台变了：${JSON.stringify([afterForgedFeatures, afterForgedScenarios])}`);

  return {
    lines: [`两个版本（版本号 ${first.specVersionId}、${second.specVersionId}），${changeRows.length} 条变化行都带身份；人工下线的 Login 没有回到版本里，工作台行上已有的身份没被覆盖`],
    problems,
  };
}

/** 走一遍完整的演练，返回报告的各行。任何一步对不上都抛错。临时库默认在结束时删掉。 */
export async function run(options: VerifyOptions): Promise<string[]> {
  const database = scratchDatabase(options.url);
  // 仓库的连接池从这里读配置。只改这个进程和它启动的子进程，不碰别的。
  process.env.DATABASE_URL = options.url;
  process.env.DATABASE_SSL = "false";
  process.env.SPEC_IDENTITY_LAYER = "true";
  const admin = await mysql.createConnection({ ...databaseConfig(), database: undefined });
  let pool: Pool | undefined;
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    if (options.md5StandIn) await admin.query(`CREATE FUNCTION \`${database}\`.MD5(s TEXT) RETURNS CHAR(32) DETERMINISTIC RETURN SUBSTRING(SHA2(s, 256), 1, 32)`);
    const server = (await rowsOf(admin, "SELECT VERSION() AS version"))[0].version;

    const migration = mustSucceed(runScript("scripts/migrate.ts"), "迁移");
    const lines = [`临时库 ${database}，服务器 MySQL ${server}`, `迁移：仓库自己的入口，${migration.output.split("\n").filter((line) => line.startsWith("Applied ")).length} 个迁移文件，${migration.seconds} 秒`];

    pool = mysql.createPool(databaseConfig());
    const versions = parseLedgerExport(await readFile(options.ledgerPath, "utf8"));
    const chains = chainsOf(versions);
    const started = Date.now();
    await inTransaction(pool, (connection) => loadLedger(connection, versions));
    const rows = versions.reduce((total, version) => total + version.features.length + version.scenarios.length + version.changes.length, 0);
    lines.push(`账本：${chains.size} 个仓库 ${versions.length} 个版本 ${rows} 行，${(Date.now() - started) / 1000} 秒`);

    const apply = (what: string) => mustSucceed(runScript("scripts/backfill-spec-identities.ts", ["--apply"]), what);
    lines.push(`回填演练：${mustSucceed(runScript("scripts/backfill-spec-identities.ts"), "回填演练").seconds} 秒`);
    let result = apply("回填写入");
    lines.push(`回填写入：${result.seconds} 秒`);

    const expected = expectedState(chains);
    mustBeEmpty(diffStates(expected, await stateOf(pool)), "回填写入之后逐行核对");
    lines.push(`逐行核对：${versions.length} 个版本、${rows} 行的身份，登记表 ${expected.registry.size} 行、关系表 ${expected.links.size} 行，全部和按规则离线算出来的一样`);

    // 登记表里「首次出现的版本」被改晚了（部署之后、回填之前发布过），再回填一遍要改回真正最早的。
    const earliest = (await rowsOf(pool, "SELECT product_id AS productId, identity_key AS identityKey, first_name AS firstName, first_spec_version_id AS firstVersionId FROM feature_identities ORDER BY first_spec_version_id, id LIMIT 1"))[0];
    const latest = Number((await rowsOf(pool, "SELECT MAX(id) AS versionId FROM spec_versions"))[0].versionId);
    await pool.execute("UPDATE feature_identities SET first_spec_version_id = ? WHERE product_id = ? AND identity_key = ?", [latest, Number(earliest.productId), text(earliest.identityKey)]);
    const rowKey = (versionId: number) => JSON.stringify(["feature_identities", Number(earliest.productId), earliest.identityKey, earliest.firstName, versionId]);
    // 核对必须恰好看见这一处改动：确实改动了，而且没有连带别的行。
    const tampered = diffStates(expected, await stateOf(pool));
    mustBe(
      JSON.stringify(tampered) === JSON.stringify([`登记表：缺 ${rowKey(Number(earliest.firstVersionId))}`, `登记表：多 ${rowKey(latest)}`]),
      "改动登记表里一行之后，逐行核对应该恰好查出这一行的前后两个值",
      tampered,
    );
    result = apply("第二次回填写入");
    mustBeEmpty(diffStates(expected, await stateOf(pool)), "第二次写入之后逐行核对");
    lines.push(`再写一遍：${result.seconds} 秒，一行未变；登记表里一个被改晚了的「首次出现的版本」已改回版本 ${earliest.firstVersionId}`);

    const plain = await publishTwice(pool, syntheticIds(100), false);
    mustBeEmpty(plain.problems, "发布写入（功能没改名）");
    lines.push("发布写入：", `功能没改名：${plain.lines.join("；")}`);

    const afterWritePath = await stateOf(pool);
    result = apply("发布之后的回填写入");
    mustBeEmpty(diffStates(afterWritePath, await stateOf(pool)), "回填对发布写入过的仓库再写一遍之后逐行核对");
    lines.push(`回填对全部仓库再写一遍：${result.seconds} 秒，一行未变`);

    // 放在回填之后：改过名的数据里有一行身份和名称键不同，这只有客户端协议才会写出来。
    // 回填按名称键从头重算，会把它改回去，所以回填之后不能再对那样的仓库跑。今天的数据里身份就是名称键。
    const renamed = await publishTwice(pool, syntheticIds(0), true);
    mustBeEmpty(renamed.problems, "发布写入（功能改过名）");
    lines.push(`功能改过名：${renamed.lines.join("；")}`);
    return lines;
  } finally {
    await pool?.end();
    try {
      if (!options.keep) await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
  }
}

async function main(): Promise<void> {
  const url = process.env[ENV_URL];
  if (!url) throw new Error(`缺少 ${ENV_URL}：这个脚本只认它，不读 DATABASE_URL（它会删库重建，不能指向别的库）`);
  const args = parseArgs(process.argv.slice(2));
  for (const line of await run({ ...args, url })) console.log(line);
  if (args.keep) console.log(`临时库留着没有删（--keep）。`);
  console.log("全部通过");
}

if (process.argv[1]?.endsWith("verify-spec-identity-mysql.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
