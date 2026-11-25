#!/usr/bin/env tsx
import "dotenv/config";
import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import type { Execute } from "../lib/db";
import {
  SpecIdentityError,
  emptyIdentityMaps,
  foldRegistry,
  planVersionIdentities,
  changeRowIdentity,
  scenarioAssignments,
  toVersionIdentities,
  type IdentityRegistry,
  type VersionIdentities,
  type VersionIdentityPlan,
} from "../lib/spec-identity";
import { assignVersionIdentities, identityInputsOf, resultRows, type IdentityRows } from "../lib/spec-identity-store";

/**
 * 身份层回填（规格《客户端增量分析与 Delta Merge Contract 设计》§20）。
 *
 * 给已有的每个规格版本补上功能和场景的身份列，并把身份登记表和关系记录填好。
 * 身份按 lib/spec-identity.ts 的规则算出来，发布时的写入路径用的是同一套规则，所以回填出来的身份
 * 和之后发布写出来的身份在同一条版本链上是连续的。
 *
 * 用法：
 *   npx tsx scripts/backfill-spec-identities.ts [--repository <仓库号>]... [--apply]
 *
 * 默认只演练：读全部版本、算出身份、出报告，一个字节都不写。确认报告里没有冲突之后再加 --apply。
 * 写入时每个仓库一个事务：遇到冲突（同一版里两个条目落到同一个身份等）整个仓库回滚，别的仓库照常。
 * 可以重复运行：登记表只追加，重复的身份不覆盖；行上的身份再写一遍是同一个值。
 */

export interface BackfillRepository {
  repositoryId: number;
  productId: number;
}

/** 回填要用的全部读取。生产走数据库；测试和离线演练可以给一份内存里的或者导出来的数据。 */
export interface BackfillSource {
  repositories(repositoryIds: readonly number[]): Promise<BackfillRepository[]>;
  /** 按发布顺序（版本号从小到大）。 */
  versions(repositoryId: number): Promise<number[]>;
  rows(specVersionId: number): Promise<IdentityRows>;
}

export interface RepositoryBackfillReport {
  repositoryId: number;
  productId: number;
  /** 算完的版本数。中途遇到冲突时，是冲突之前算完的那些。 */
  versions: number;
  featureRows: number;
  scenarioRows: number;
  changeRows: number;
  /** 三处（本版、上一版、登记表）里至少一处认得的变化行。 */
  assignedChanges: number;
  mintedFeatures: number;
  mintedScenarios: number;
  retiredFeatures: number;
  retiredScenarios: number;
  restoredFeatures: number;
  restoredScenarios: number;
  /** 父功能的名称键不在本版里的次数。历史数据里有悬空的父键，这里不猜，身份留空。 */
  unresolvedParents: number;
  /** 所属功能不在本版里的场景行。数据不该长这样，遇到了照实报出来。 */
  orphanScenarios: number;
  /** 失败关闭的原因，带着版本号。没有冲突就是 null。 */
  conflict: string | null;
}

export type BackfillWrite = (specVersionId: number, rows: IdentityRows, previous: VersionIdentities, registry: IdentityRegistry) => Promise<VersionIdentityPlan>;

export type BackfillTransaction = (repository: BackfillRepository, work: (execute: Execute) => Promise<RepositoryBackfillReport>) => Promise<RepositoryBackfillReport>;

export interface BackfillReport {
  apply: boolean;
  repositories: RepositoryBackfillReport[];
}

export function parseArgs(argv: readonly string[]): { repositoryIds: number[]; apply: boolean } {
  const repositoryIds: number[] = [];
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    if (flag !== "--repository") throw new Error(`不认识的参数：${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("参数 --repository 缺少取值");
    if (!/^\d+$/.test(value)) throw new Error(`--repository 要填仓库号，收到的是：${value}`);
    repositoryIds.push(Number(value));
    index += 1;
  }
  return { repositoryIds, apply };
}

function emptyReport(repository: BackfillRepository): RepositoryBackfillReport {
  return {
    repositoryId: repository.repositoryId,
    productId: repository.productId,
    versions: 0,
    featureRows: 0,
    scenarioRows: 0,
    changeRows: 0,
    assignedChanges: 0,
    mintedFeatures: 0,
    mintedScenarios: 0,
    retiredFeatures: 0,
    retiredScenarios: 0,
    restoredFeatures: 0,
    restoredScenarios: 0,
    unresolvedParents: 0,
    orphanScenarios: 0,
    conflict: null,
  };
}

function countVersion(report: RepositoryBackfillReport, rows: IdentityRows, plan: VersionIdentityPlan, previous: VersionIdentities, registry: IdentityRegistry): void {
  const features = [...plan.features.values()];
  const featureIds = new Set(rows.features.map((feature) => feature.id));
  report.versions += 1;
  report.featureRows += rows.features.length;
  report.scenarioRows += rows.scenarios.length;
  report.changeRows += rows.changes.length;
  report.mintedFeatures += plan.minted.features.length;
  report.mintedScenarios += plan.minted.scenarios.length;
  report.retiredFeatures += plan.retired.features.length;
  report.retiredScenarios += plan.retired.scenarios.length;
  report.restoredFeatures += features.filter((feature) => feature.origin === "restored").length;
  report.restoredScenarios += scenarioAssignments(plan).filter((scenario) => scenario.origin === "restored").length;
  report.unresolvedParents += features.filter((feature) => !feature.parentResolved).length;
  report.orphanScenarios += rows.scenarios.filter((scenario) => !featureIds.has(scenario.featureId)).length;
  report.assignedChanges += rows.changes.filter((change) => {
    const identity = changeRowIdentity(change, plan, previous, registry);
    return identity.featureIdentityKey !== null || identity.scenarioIdentityKey !== null;
  }).length;
}

/**
 * 回填一个仓库。不传 write 就是演练：身份照算，报告照出，什么都不写。
 * 登记表从空开始，沿着这条版本链重新长一遍：规则是确定的，长出来的和库里已有的一样。
 */
export async function backfillRepository(input: { repository: BackfillRepository; source: BackfillSource; write?: BackfillWrite }): Promise<RepositoryBackfillReport> {
  const report = emptyReport(input.repository);
  let previous: VersionIdentities = emptyIdentityMaps();
  let registry: IdentityRegistry = emptyIdentityMaps();
  for (const specVersionId of await input.source.versions(input.repository.repositoryId)) {
    const rows = await input.source.rows(specVersionId);
    let plan: VersionIdentityPlan;
    try {
      plan = input.write ? await input.write(specVersionId, rows, previous, registry) : planVersionIdentities({ features: identityInputsOf(rows), previous, registry });
    } catch (error) {
      if (!(error instanceof SpecIdentityError)) throw error;
      report.conflict = `版本 ${specVersionId}：${error.code} ${error.message}`;
      return report;
    }
    countVersion(report, rows, plan, previous, registry);
    registry = foldRegistry(registry, plan);
    previous = toVersionIdentities(plan);
  }
  return report;
}

export async function backfill(input: { source: BackfillSource; repositoryIds?: readonly number[]; apply: boolean; inTransaction?: BackfillTransaction }): Promise<BackfillReport> {
  const inTransaction = input.inTransaction;
  if (input.apply && !inTransaction) throw new Error("写入必须在事务里进行：没有给 inTransaction");
  const repositories = await input.source.repositories(input.repositoryIds ?? []);
  const reports: RepositoryBackfillReport[] = [];
  for (const repository of repositories) {
    reports.push(
      input.apply && inTransaction
        ? await inTransaction(repository, (execute) =>
            backfillRepository({
              repository,
              source: input.source,
              write: (specVersionId, rows, previous, registry) => assignVersionIdentities(repository.productId, specVersionId, rows, previous, execute, registry),
            }),
          )
        : await backfillRepository({ repository, source: input.source }),
    );
  }
  return { apply: input.apply, repositories: reports };
}

/** 有规格版本的仓库。给了仓库号就只取这些。 */
export async function loadBackfillRepositories(execute: Execute, repositoryIds: readonly number[]): Promise<BackfillRepository[]> {
  const filter = repositoryIds.length === 0 ? "" : ` AND r.id IN (${repositoryIds.map(() => "?").join(",")})`;
  const rows = resultRows(await execute(`SELECT r.id AS repositoryId, r.product_id AS productId FROM repositories r WHERE EXISTS (SELECT 1 FROM spec_versions v WHERE v.repository_id = r.id)${filter} ORDER BY r.id`, [...repositoryIds]));
  return rows.map((row) => ({ repositoryId: Number(row.repositoryId), productId: Number(row.productId) }));
}

/** 一个仓库的全部版本，按发布顺序。 */
export async function loadBackfillVersions(execute: Execute, repositoryId: number): Promise<number[]> {
  return resultRows(await execute("SELECT id AS versionId FROM spec_versions WHERE repository_id = ? ORDER BY id", [repositoryId])).map((row) => Number(row.versionId));
}

/** 一个版本里要补身份的行。三条语句都只读。 */
export async function loadIdentityRows(execute: Execute, specVersionId: number): Promise<IdentityRows> {
  const [features, scenarios, changes] = await Promise.all([
    execute("SELECT id, name, parent_key AS parentKey FROM spec_features WHERE spec_version_id = ? ORDER BY position", [specVersionId]),
    execute("SELECT ss.id, ss.spec_feature_id AS featureId, ss.reference FROM spec_scenarios ss JOIN spec_features sf ON sf.id = ss.spec_feature_id WHERE sf.spec_version_id = ?", [specVersionId]),
    execute("SELECT id, feature_key AS featureKey, scenario_reference AS scenarioReference FROM spec_changes WHERE spec_version_id = ?", [specVersionId]),
  ]);
  return {
    features: resultRows(features).map((row) => ({ id: Number(row.id), name: String(row.name), parentKey: typeof row.parentKey === "string" ? row.parentKey : null })),
    scenarios: resultRows(scenarios).map((row) => ({ id: Number(row.id), featureId: Number(row.featureId), reference: String(row.reference) })),
    changes: resultRows(changes).map((row) => ({ id: Number(row.id), featureKey: String(row.featureKey), scenarioReference: typeof row.scenarioReference === "string" ? row.scenarioReference : "" })),
  };
}

/** 生产数据源：只读，每样东西一条语句。 */
export function dbBackfillSource(execute: Execute): BackfillSource {
  return {
    repositories: (repositoryIds) => loadBackfillRepositories(execute, repositoryIds),
    versions: (repositoryId) => loadBackfillVersions(execute, repositoryId),
    rows: (specVersionId) => loadIdentityRows(execute, specVersionId),
  };
}

/** 每个仓库一个事务：报告里有冲突就回滚，否则提交。work 自己抛出来的错误回滚后原样抛出。 */
export function poolTransaction(pool: Pick<Pool, "getConnection">): BackfillTransaction {
  return async (repository, work) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      let report: RepositoryBackfillReport;
      try {
        report = await work((statement, parameters) => connection.execute(statement, parameters));
      } catch (error) {
        await connection.rollback();
        throw error;
      }
      if (report.conflict) await connection.rollback();
      else await connection.commit();
      return report;
    } finally {
      connection.release();
    }
  };
}

export function renderReport(report: BackfillReport): string {
  if (report.repositories.length === 0) return "没有需要回填的仓库。\n";
  const committed = report.repositories.filter((entry) => entry.conflict === null).length;
  const rolledBack = report.repositories.length - committed;
  const lines = [
    report.apply
      ? `身份回填：写入模式。已写入 ${committed} 个仓库${rolledBack > 0 ? `，${rolledBack} 个仓库因冲突回滚，没有改动` : ""}。`
      : "身份回填：演练，没有写入任何数据。确认报告无误后加 --apply 执行。",
    "",
    "| 仓库 | 版本 | 功能行 | 场景行 | 变化行 | 已写身份的变化行 | 新建功能身份 | 新建场景身份 | 退休功能 | 退休场景 | 恢复功能 | 恢复场景 | 父功能未解析 | 孤儿场景 | 冲突 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...report.repositories.map((entry) =>
      `| ${entry.repositoryId} | ${entry.versions} | ${entry.featureRows} | ${entry.scenarioRows} | ${entry.changeRows} | ${entry.assignedChanges} | ${entry.mintedFeatures} | ${entry.mintedScenarios} | ${entry.retiredFeatures} | ${entry.retiredScenarios} | ${entry.restoredFeatures} | ${entry.restoredScenarios} | ${entry.unresolvedParents} | ${entry.orphanScenarios} | ${entry.conflict === null ? "无" : "有"} |`,
    ),
  ];
  const conflicts = report.repositories.filter((entry) => entry.conflict !== null);
  if (conflicts.length > 0) {
    lines.push("", "冲突（这些仓库的身份层不能启用，要先看原因）：", ...conflicts.map((entry) => `- 仓库 ${entry.repositoryId}：${entry.conflict}`));
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = mysql.createPool(databaseConfig());
  try {
    const report = await backfill({
      source: dbBackfillSource((statement, parameters) => pool.execute(statement, parameters)),
      repositoryIds: args.repositoryIds,
      apply: args.apply,
      inTransaction: args.apply ? poolTransaction(pool) : undefined,
    });
    console.log(renderReport(report));
    if (report.repositories.some((entry) => entry.conflict !== null)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("backfill-spec-identities.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
