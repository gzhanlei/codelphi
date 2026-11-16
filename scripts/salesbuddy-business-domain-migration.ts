import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";

/**
 * SalesBuddy 业务域一次性迁移（计划文档：docs/superpowers/plans/2026-11-17-salesbuddy-business-domains.md）。
 * 只做两件事：人工确认的 6 个业务父节点（source='manual'）+ 22 个子功能只改 parent_id。
 * 原功能 id/name/display_name/summary/source/核实状态/编辑归因/场景/证据/发布历史全部不动；
 * 23 个技术/运维功能保持 parent_id=NULL，只留在完整规格。
 * 用法：npx tsx scripts/salesbuddy-business-domain-migration.ts --product salesbuddy [--apply]
 * 无 --apply 只输出计划（dry-run）；生产写入必须先 dry-run、人工审阅并生成备份。
 * 本清单仅用于 SalesBuddy 一次性迁移，不得作为其他项目的默认值。
 */

export interface SalesBuddyDomain {
  key: string;
  name: string;
  summary: string;
  featureIds: number[];
}

export const SALESBUDDY_DOMAINS: SalesBuddyDomain[] = [
  { key: "communication", name: "客户沟通", summary: "汇总面谈、邮件、微信、录音笔与速记等客户沟通来源。", featureIds: [15118, 71, 15138] },
  {
    key: "cognition",
    name: "客户认知",
    summary: "通过转写、复盘与持续积累形成客户档案和客户理解。",
    featureIds: [299, 15122, 15123, 15127, 15133, 15134, 298, 15150, 15153, 15157, 72, 15161],
  },
  { key: "opportunity", name: "商机管理", summary: "了解购买意愿、商机进展及其沟通来源。", featureIds: [15129, 15130] },
  { key: "promise", name: "承诺管理", summary: "识别双方承诺并跟踪履约和逾期情况。", featureIds: [15160] },
  { key: "execution", name: "销售执行", summary: "管理后续跟进、日历、待办与通知。", featureIds: [77, 15139, 15154] },
  { key: "team", name: "团队管理", summary: "通过管理者视图了解团队客户进展与协作情况。", featureIds: [74] },
];

export const SALESBUDDY_UNGROUPED_IDS: number[] = [
  15117, 15119, 15121, 15124, 305, 14951, 15128, 15131, 15135, 15137, 78, 15140, 15142, 15143,
  14956, 14957, 14958, 14959, 15149, 15151, 15152, 304, 301,
];

export interface MigrationFeatureRow {
  id: number;
  name: string;
  summary: string;
  parentId: number | null;
  source: string;
  active: number;
  verifiedAt?: Date | string | null;
  verifiedBy?: string | null;
  lastEditedAt?: Date | string | null;
  lastEditedBy?: string | null;
}

export interface MigrationMove {
  featureId: number;
  featureName: string;
  targetDomainKey: string;
  fromParentId: number | null;
  source: string;
}

export interface MigrationPlan {
  parents: Array<{ key: string; name: string; summary: string }>;
  moves: MigrationMove[];
  ungrouped: Array<{ id: number; name: string }>;
  /** 每个子功能的当前值快照（回滚依据）。 */
  snapshot: Record<number, { parentId: number | null; source: string; verifiedAt: unknown; verifiedBy: string | null; lastEditedAt: unknown; lastEditedBy: string | null }>;
  errors: string[];
}

/** 校验映射并在任何冲突时中止（未知 ID/重复/已有父级/目标冲突）。 */
export function planSalesBuddyBusinessDomainMigration(
  features: MigrationFeatureRow[],
  domains: SalesBuddyDomain[] = SALESBUDDY_DOMAINS,
  ungroupedIds: number[] = SALESBUDDY_UNGROUPED_IDS,
): MigrationPlan {
  const errors: string[] = [];
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const claimed = new Map<number, string[]>();
  for (const domain of domains) {
    for (const id of domain.featureIds) {
      const seen = claimed.get(id) ?? [];
      seen.push(domain.key);
      claimed.set(id, seen);
      if (!byId.has(id)) errors.push(`未知功能 ID ${id}（域 ${domain.key}）；整个迁移中止`);
      else if (byId.get(id)!.parentId !== null) errors.push(`功能 ${id} 已有父级 ${byId.get(id)!.parentId}；整个迁移中止`);
    }
  }
  for (const id of ungroupedIds) {
    if (!byId.has(id)) errors.push(`未分组清单引用未知功能 ID ${id}；整个迁移中止`);
  }
  for (const [id, keys] of claimed) {
    if (keys.length > 1) errors.push(`功能 ${id} 被多个域引用（${keys.join("、")}）：目标父级冲突，整个迁移中止`);
  }
  if (errors.length > 0) return { parents: [], moves: [], ungrouped: [], snapshot: {}, errors };
  return {
    parents: domains.map((domain) => ({ key: domain.key, name: domain.name, summary: domain.summary })),
    moves: domains.flatMap((domain) =>
      domain.featureIds.map((id) => {
        const feature = byId.get(id)!;
        return { featureId: id, featureName: feature.name, targetDomainKey: domain.key, fromParentId: feature.parentId, source: feature.source };
      }),
    ),
    ungrouped: ungroupedIds.map((id) => ({ id, name: byId.get(id)!.name })),
    snapshot: Object.fromEntries(
      domains.flatMap((domain) => domain.featureIds).concat(ungroupedIds).map((id) => {
        const feature = byId.get(id)!;
        return [id, { parentId: feature.parentId, source: feature.source, verifiedAt: feature.verifiedAt ?? null, verifiedBy: feature.verifiedBy ?? null, lastEditedAt: feature.lastEditedAt ?? null, lastEditedBy: feature.lastEditedBy ?? null }];
      }),
    ),
    errors: [],
  };
}

/** 测试/生产可注入的连接面：生产走 mysql2 事务连接。 */
export interface MigrationConnection {
  execute(statement: string, parameters?: unknown[]): Promise<unknown>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export async function connectMigration(): Promise<MigrationConnection> {
  const connection = await mysql.createConnection(databaseConfig());
  return {
    execute: (statement, parameters) => connection.execute(statement, parameters as never[]),
    beginTransaction: () => connection.beginTransaction(),
    commit: () => connection.commit(),
    rollback: () => connection.rollback(),
    release: () => connection.end(),
  };
}

type QueryResult<Row> = [Row[], unknown];

function rowsOf<Row>(result: unknown): Row[] {
  return (result as QueryResult<Row>)[0];
}

function insertIdOf(result: unknown): number {
  const header = (result as [{ insertId: number }, unknown])[0];
  return header.insertId;
}

async function loadProductId(connection: MigrationConnection, productSlug: string): Promise<number | null> {
  const rows = rowsOf<{ id: number; slug: string }>(await connection.execute("SELECT id, slug FROM products WHERE slug = ?", [productSlug]));
  return rows.length === 1 ? rows[0].id : null;
}

async function loadFeatures(connection: MigrationConnection, productId: number): Promise<MigrationFeatureRow[]> {
  return rowsOf<MigrationFeatureRow>(
    await connection.execute(
      "SELECT id, name, summary, parent_id AS parentId, source, active, verified_at AS verifiedAt, verified_by AS verifiedBy, last_edited_at AS lastEditedAt, last_edited_by AS lastEditedBy FROM features WHERE product_id = ? AND active = 1",
      [productId],
    ),
  );
}

export interface MigrationRunOptions {
  productSlug: string;
  apply?: boolean;
  /** 备份目录（默认 artifacts/business-domain-backups；备份不提交、不公开客户数据）。 */
  backupDir?: string;
  /** 回滚路径：--restore <backup.json> --apply。 */
  restoreFrom?: string;
  connection?: MigrationConnection;
}

export interface MigrationRunResult {
  ok: boolean;
  applied: boolean;
  productName: string;
  plan: MigrationPlan;
  errors: string[];
  backupPath?: string;
}

const BACKUP_KIND = "salesbuddy-business-domain-migration";
const INSERT_PARENT_SQL = "INSERT INTO features (product_id, name, display_name, summary, parent_id, source, active) VALUES (?, ?, ?, ?, NULL, 'manual', 1)";
const MOVE_CHILD_SQL = "UPDATE features SET parent_id = ? WHERE id = ?";
const SOFT_DISABLE_SQL = "UPDATE features SET active = 0 WHERE product_id = ? AND name = ? AND source = 'manual' AND parent_id IS NULL";

interface BackupFile {
  kind: string;
  productSlug: string;
  createdAt: string;
  domains: Array<{ key: string; name: string; summary: string }>;
  children: Array<{ id: number; name: string; fromParentId: number | null; targetDomainName: string; source: string; verifiedAt: unknown; verifiedBy: string | null; lastEditedAt: unknown; lastEditedBy: string | null }>;
}

function fail(productSlug: string, errors: string[]): MigrationRunResult {
  return { ok: false, applied: false, productName: productSlug, plan: { parents: [], moves: [], ungrouped: [], snapshot: {}, errors }, errors };
}

/** 事务写入：备份先落盘（事务外），随后单事务创建父节点并移动子功能；任何一步失败整体回滚。 */
async function applyMigration(connection: MigrationConnection, productId: number, options: MigrationRunOptions, plan: MigrationPlan, domains: SalesBuddyDomain[]): Promise<MigrationRunResult> {
  const backupDir = options.backupDir ?? "artifacts/business-domain-backups";
  const backup: BackupFile = {
    kind: BACKUP_KIND,
    productSlug: options.productSlug,
    createdAt: new Date().toISOString(),
    domains: domains.map((domain) => ({ key: domain.key, name: domain.name, summary: domain.summary })),
    children: plan.moves.map((move) => {
      const snapshot = plan.snapshot[move.featureId];
      return { id: move.featureId, name: move.featureName, fromParentId: move.fromParentId, targetDomainName: domains.find((domain) => domain.key === move.targetDomainKey)!.name, source: snapshot.source, verifiedAt: snapshot.verifiedAt, verifiedBy: snapshot.verifiedBy, lastEditedAt: snapshot.lastEditedAt, lastEditedBy: snapshot.lastEditedBy };
    }),
  };
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `salesbuddy-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  try {
    await connection.beginTransaction();
    const parentIds = new Map<string, number>();
    for (const parent of plan.parents) {
      const insertId = insertIdOf(await connection.execute(INSERT_PARENT_SQL, [productId, parent.name, parent.name, parent.summary]));
      parentIds.set(parent.key, insertId);
    }
    for (const move of plan.moves) {
      await connection.execute(MOVE_CHILD_SQL, [parentIds.get(move.targetDomainKey)!, move.featureId]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    fs.rmSync(backupPath, { force: true });
    return fail(options.productSlug, [error instanceof Error ? error.message : "迁移写入失败"]);
  }
  return { ok: true, applied: true, productName: options.productSlug, plan, errors: [], backupPath };
}

/** 回滚：恢复原 parent_id 并软下线新父节点，不硬删除任何功能。 */
async function restoreFromBackup(connection: MigrationConnection, productId: number, options: MigrationRunOptions, backup: BackupFile): Promise<MigrationRunResult> {
  const features = await loadFeatures(connection, productId);
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const drift: string[] = [];
  for (const child of backup.children) {
    const current = byId.get(child.id);
    if (!current) drift.push(`功能 ${child.id} 不存在或已下线`);
    else if (child.fromParentId === null ? current.parentId === null : current.parentId === child.fromParentId) drift.push(`功能 ${child.id} 已恢复过或父子关系漂移`);
    else {
      const currentParent = current.parentId === null ? null : byId.get(current.parentId);
      if (currentParent?.name !== child.targetDomainName) drift.push(`功能 ${child.id} 当前父级不是备份记录的目标域「${child.targetDomainName}」`);
    }
  }
  if (drift.length > 0) return fail(options.productSlug, [`当前父子关系已漂移，与备份不一致，拒绝恢复：${drift.join("；")}`]);
  try {
    await connection.beginTransaction();
    for (const child of backup.children) {
      await connection.execute(MOVE_CHILD_SQL, [child.fromParentId, child.id]);
    }
    for (const domain of backup.domains) {
      await connection.execute(SOFT_DISABLE_SQL, [productId, domain.name]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    return fail(options.productSlug, [error instanceof Error ? error.message : "回滚写入失败"]);
  }
  return { ok: true, applied: true, productName: options.productSlug, plan: { parents: [], moves: [], ungrouped: [], snapshot: {}, errors: [] }, errors: [] };
}

/** 入口：默认 dry-run（只读查询 + 计划输出）；显式 --apply 才写入，--restore + --apply 为回滚路径。 */
export async function runSalesBuddyBusinessDomainMigration(options: MigrationRunOptions): Promise<MigrationRunResult> {
  const connection = options.connection ?? (await connectMigration());
  try {
    const productId = await loadProductId(connection, options.productSlug);
    if (productId === null) return fail(options.productSlug, [`产品 ${options.productSlug} 不存在或不唯一`]);
    if (options.restoreFrom) {
      if (!options.apply) return fail(options.productSlug, ["回滚必须显式携带 --apply"]);
      if (!fs.existsSync(options.restoreFrom)) return fail(options.productSlug, [`备份文件不存在：${options.restoreFrom}`]);
      let backup: BackupFile;
      try {
        backup = JSON.parse(fs.readFileSync(options.restoreFrom, "utf8")) as BackupFile;
      } catch {
        return fail(options.productSlug, [`备份文件无法解析：${options.restoreFrom}`]);
      }
      if (backup.kind !== BACKUP_KIND || backup.productSlug !== options.productSlug) {
        return fail(options.productSlug, [`备份与产品不匹配：备份是 ${backup.productSlug ?? "未知"}（kind=${backup.kind ?? "未知"}）`]);
      }
      return await restoreFromBackup(connection, productId, options, backup);
    }
    const features = await loadFeatures(connection, productId);
    const plan = planSalesBuddyBusinessDomainMigration(features);
    if (plan.errors.length > 0) return { ok: false, applied: false, productName: options.productSlug, plan, errors: plan.errors };
    if (!options.apply) return { ok: true, applied: false, productName: options.productSlug, plan, errors: [] };
    return await applyMigration(connection, productId, options, plan, SALESBUDDY_DOMAINS);
  } finally {
    connection.release();
  }
}

// ── CLI ──
const isCli = process.argv[1]?.endsWith("salesbuddy-business-domain-migration.ts");
if (isCli) {
  const args = process.argv.slice(2);
  const productSlug = args.includes("--product") ? args[args.indexOf("--product") + 1] : null;
  const apply = args.includes("--apply");
  if (!productSlug) {
    console.error("用法：npx tsx scripts/salesbuddy-business-domain-migration.ts --product salesbuddy [--apply]");
    process.exit(1);
  }
  const result = await runSalesBuddyBusinessDomainMigration({ productSlug, apply });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(2);
}
