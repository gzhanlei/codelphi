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
  /** 增量模式：已归属目标域、无需移动的子功能。 */
  kept: Array<{ featureId: number; featureName: string; targetDomainKey: string }>;
  ungrouped: Array<{ id: number; name: string }>;
  /** 每个子功能的当前值快照（回滚依据）。 */
  snapshot: Record<number, { parentId: number | null; source: string; verifiedAt: unknown; verifiedBy: string | null; lastEditedAt: unknown; lastEditedBy: string | null }>;
  errors: string[];
}

export interface MigrationPlanOptions {
  ungroupedIds?: number[];
  /** 增量模式：已归属目标域的子功能保持不动（no-op），跨域归属仍中止。 */
  incremental?: boolean;
}

/** 通用规划（SalesBuddy 清单是它的一个特例）。增量模式供 push 后把新增功能并入既有业务域。 */
export function planBusinessDomainMigration(features: MigrationFeatureRow[], domains: SalesBuddyDomain[], options: MigrationPlanOptions = {}): MigrationPlan {
  const ungroupedIds = options.ungroupedIds ?? [];
  const incremental = options.incremental ?? false;
  const errors: string[] = [];
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const claimed = new Map<number, string[]>();
  for (const domain of domains) {
    for (const id of domain.featureIds) {
      const seen = claimed.get(id) ?? [];
      seen.push(domain.key);
      claimed.set(id, seen);
      if (!byId.has(id)) errors.push(`未知功能 ID ${id}（域 ${domain.key}）；整个迁移中止`);
    }
  }
  for (const [id, keys] of claimed) {
    if (keys.length > 1) errors.push(`功能 ${id} 被多个域引用（${keys.join("、")}）：目标父级冲突，整个迁移中止`);
  }
  for (const id of ungroupedIds) {
    if (!byId.has(id)) errors.push(`未分组清单引用未知功能 ID ${id}；整个迁移中止`);
  }
  // 域名与现有功能同名 → 父节点 INSERT 会撞 product_id+name 唯一键并劫持该功能行
  // （2026-11-17 Chandler 自指事故根因）。豁免：同名行是本域成员的既有父节点（幂等重跑，
  // 归组状态由后续「已有父级/kept」逻辑判定）。
  for (const domain of domains) {
    const sameNameRows = features.filter((row) => row.name === domain.name);
    if (sameNameRows.length === 0) continue;
    const isOwnParentRow = (row: MigrationFeatureRow) =>
      row.source === "manual" && domain.featureIds.some((id) => byId.get(id)?.parentId === row.id);
    if (!sameNameRows.every(isOwnParentRow)) {
      errors.push(`业务域「${domain.name}」与现有功能同名（features 唯一键 product_id+name）：改域名后重试；整个迁移中止`);
    }
  }
  if (errors.length > 0) return { parents: [], moves: [], kept: [], ungrouped: [], snapshot: {}, errors };
  const moves: MigrationMove[] = [];
  const kept: MigrationPlan["kept"] = [];
  for (const domain of domains) {
    for (const id of domain.featureIds) {
      const featureRow = byId.get(id)!;
      if (featureRow.parentId === null) {
        moves.push({ featureId: id, featureName: featureRow.name, targetDomainKey: domain.key, fromParentId: null, source: featureRow.source });
        continue;
      }
      if (!incremental) errors.push(`功能 ${id} 已有父级 ${featureRow.parentId}；整个迁移中止`);
      else {
        const currentParent = byId.get(featureRow.parentId);
        if (!currentParent) errors.push(`功能 ${id} 的当前父级 ${featureRow.parentId} 不存在或已下线；整个迁移中止`);
        else if (currentParent.name !== domain.name) errors.push(`功能 ${id} 当前父级「${currentParent.name}」与目标域「${domain.name}」冲突；整个迁移中止`);
        else kept.push({ featureId: id, featureName: featureRow.name, targetDomainKey: domain.key });
      }
    }
  }
  if (errors.length > 0) return { parents: [], moves: [], kept: [], ungrouped: [], snapshot: {}, errors };
  return {
    parents: domains.map((domain) => ({ key: domain.key, name: domain.name, summary: domain.summary })),
    moves,
    kept,
    ungrouped: ungroupedIds.map((id) => ({ id, name: byId.get(id)!.name })),
    snapshot: Object.fromEntries(
      domains.flatMap((domain) => domain.featureIds).concat(ungroupedIds).map((id) => {
        const featureRow = byId.get(id)!;
        return [id, { parentId: featureRow.parentId, source: featureRow.source, verifiedAt: featureRow.verifiedAt ?? null, verifiedBy: featureRow.verifiedBy ?? null, lastEditedAt: featureRow.lastEditedAt ?? null, lastEditedBy: featureRow.lastEditedBy ?? null }];
      }),
    ),
    errors: [],
  };
}

/** SalesBuddy 一次性清单（计划文档 2026-11-17）的严格语义包装。 */
export function planSalesBuddyBusinessDomainMigration(
  features: MigrationFeatureRow[],
  domains: SalesBuddyDomain[] = SALESBUDDY_DOMAINS,
  ungroupedIds: number[] = SALESBUDDY_UNGROUPED_IDS,
): MigrationPlan {
  return planBusinessDomainMigration(features, domains, { ungroupedIds, incremental: false });
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
  /** 通用化：审核后的业务域映射（缺省走 SalesBuddy 一次性清单）。 */
  domains?: SalesBuddyDomain[];
  ungroupedIds?: number[];
  incremental?: boolean;
}

export interface MigrationRunResult {
  ok: boolean;
  applied: boolean;
  productName: string;
  plan: MigrationPlan;
  errors: string[];
  backupPath?: string;
}

/** 解析审核后的候选 JSON（设置页「全部接受」输出的形态，也接受 { domains, ungroupedIds }）。 */
export function parseDomainsDocument(content: string): { domains: SalesBuddyDomain[]; ungroupedIds: number[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { domains: [], ungroupedIds: [], errors: ["业务域映射不是合法 JSON"] };
  }
  const rawList = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { domains?: unknown }).domains)
      ? (parsed as { domains: unknown[] }).domains
      : null;
  if (!rawList || rawList.length === 0) return { domains: [], ungroupedIds: [], errors: ["业务域映射为空：需要非空数组或 { domains: [...] }"] };
  const errors: string[] = [];
  const domains: SalesBuddyDomain[] = [];
  const seenNames = new Set<string>();
  rawList.forEach((item, index) => {
    if (item === null || typeof item !== "object" || typeof (item as { name?: unknown }).name !== "string" || (item as { name: string }).name.trim() === "") {
      errors.push(`第 ${index + 1} 个业务域缺少名称`);
      return;
    }
    const name = ((item as { name: string }).name).trim();
    const key = typeof (item as { key?: unknown }).key === "string" && (item as { key: string }).key.trim() !== "" ? (item as { key: string }).key.trim() : name;
    if (seenNames.has(name) || domains.some((domain) => domain.key === key)) {
      errors.push(`业务域「${name}」名称/键重复`);
      return;
    }
    seenNames.add(name);
    const rawIds = (item as { featureIds?: unknown }).featureIds;
    // 与候选解析同口径：数字字符串（"79"）容错，非数字拒绝（2026-11-17 Chandler 实测键漂移）。
    const normalizedIds = Array.isArray(rawIds)
      ? rawIds.map((id) => {
          if (typeof id === "number" && Number.isInteger(id)) return id;
          if (typeof id === "string" && /^\d+$/.test(id.trim())) return Number(id.trim());
          return null;
        })
      : [];
    if (normalizedIds.some((id) => id === null) || normalizedIds.length === 0) {
      errors.push(`业务域「${name}」的 featureIds 必须是非空整数数组`);
      return;
    }
    const featureIds = [...new Set(normalizedIds as number[])];
    domains.push({ key, name, summary: typeof (item as { summary?: unknown }).summary === "string" ? (item as { summary: string }).summary : "", featureIds });
  });
  let ungroupedIds: number[] = [];
  if (!Array.isArray(parsed) && parsed !== null && typeof parsed === "object") {
    const rawUngrouped = (parsed as { ungroupedIds?: unknown }).ungroupedIds;
    if (rawUngrouped !== undefined) {
      if (!Array.isArray(rawUngrouped) || !rawUngrouped.every((id) => typeof id === "number")) errors.push("ungroupedIds 必须是数字数组");
      else ungroupedIds = rawUngrouped as number[];
    }
  }
  if (errors.length > 0) return { domains: [], ungroupedIds: [], errors };
  return { domains, ungroupedIds, errors: [] };
}

const BACKUP_KIND = "salesbuddy-business-domain-migration";
const INSERT_PARENT_SQL =
  "INSERT INTO features (product_id, name, display_name, summary, parent_id, source, active) VALUES (?, ?, ?, ?, NULL, 'manual', 1) " +
  "ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), active = 1";
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
  return { ok: false, applied: false, productName: productSlug, plan: { parents: [], moves: [], kept: [], ungrouped: [], snapshot: {}, errors }, errors };
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
  const backupPath = path.join(backupDir, `${options.productSlug}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  try {
    await connection.beginTransaction();
    const parentIds = new Map<string, number>();
    for (const parent of plan.parents) {
      const insertResult = await connection.execute(INSERT_PARENT_SQL, [productId, parent.name, parent.name, parent.summary]);
      const insertId = insertIdOf(insertResult);
      // 纵深防御：撞唯一键时 LAST_INSERT_ID 返回已存在行——若非 manual 域行则中止（防功能行被劫持成父节点）。
      const parentRows = rowsOf<{ source: string }>(await connection.execute("SELECT source FROM features WHERE id = ?", [insertId]));
      if (parentRows.length !== 1 || parentRows[0].source !== "manual") {
        throw new Error(`父节点「${parent.name}」解析到非 manual 行（id=${insertId}），中止写入`);
      }
      parentIds.set(parent.key, insertId);
    }
    for (const move of plan.moves) {
      const parentId = parentIds.get(move.targetDomainKey)!;
      if (parentId === move.featureId) throw new Error(`功能 ${move.featureId} 的目标父级是自身（自指），中止写入`);
      await connection.execute(MOVE_CHILD_SQL, [parentId, move.featureId]);
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
  return { ok: true, applied: true, productName: options.productSlug, plan: { parents: [], moves: [], kept: [], ungrouped: [], snapshot: {}, errors: [] }, errors: [] };
}

/** 通用入口：显式提供 domains 映射；restoreFrom 回滚路径不需要映射。 */
export async function runBusinessDomainMigration(options: MigrationRunOptions): Promise<MigrationRunResult> {
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
    const domains = options.domains;
    if (!domains || domains.length === 0) return fail(options.productSlug, ["缺少业务域映射（--domains 候选JSON 或 runBusinessDomainMigration({ domains })）"]);
    const features = await loadFeatures(connection, productId);
    const plan = planBusinessDomainMigration(features, domains, { ungroupedIds: options.ungroupedIds ?? [], incremental: options.incremental ?? false });
    if (plan.errors.length > 0) return { ok: false, applied: false, productName: options.productSlug, plan, errors: plan.errors };
    if (!options.apply) return { ok: true, applied: false, productName: options.productSlug, plan, errors: [] };
    return await applyMigration(connection, productId, options, plan, domains);
  } finally {
    connection.release();
  }
}

/** SalesBuddy 一次性迁移入口（计划文档 2026-11-17）：固定清单、严格语义（已有父级即中止）。 */
export async function runSalesBuddyBusinessDomainMigration(options: Omit<MigrationRunOptions, "domains" | "ungroupedIds" | "incremental">): Promise<MigrationRunResult> {
  return runBusinessDomainMigration({ ...options, domains: SALESBUDDY_DOMAINS, ungroupedIds: SALESBUDDY_UNGROUPED_IDS, incremental: false });
}

// ── CLI ──
const isCli = process.argv[1]?.endsWith("salesbuddy-business-domain-migration.ts");
if (isCli) {
  async function main() {
    const args = process.argv.slice(2);
    const productSlug = args.includes("--product") ? args[args.indexOf("--product") + 1] : null;
    const apply = args.includes("--apply");
    const restoreFrom = args.includes("--restore") ? args[args.indexOf("--restore") + 1] : undefined;
    const backupDir = args.includes("--backupDir") ? args[args.indexOf("--backupDir") + 1] : undefined;
    if (!productSlug) {
      console.error("用法：npx tsx scripts/salesbuddy-business-domain-migration.ts --product salesbuddy [--apply] [--restore <backup.json> --apply] [--backupDir <dir>]");
      process.exit(1);
    }
    const result = await runSalesBuddyBusinessDomainMigration({ productSlug, apply, restoreFrom, backupDir });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(2);
  }
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
