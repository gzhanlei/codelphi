import "dotenv/config";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { changeDescriptionVariantSimilar, specFeatureKey } from "../lib/spec-diff";

/**
 * BM-11 存量清理（changes 表）：release 的行为变化清单（changes 表）由各分区 AI 条目
 * 落库，BM-11 之前的合并层只做描述原文精确去重——同一行为变化的措辞变体（release 225
 * 「分析完整性账本」partial 披露 ×7、release 224 反馈后台条目 ×多）全量留存。
 * 判定复用 changeDescriptionVariantSimilar（与新管线合并层同一口径）。
 * 守护：同 release 内、同 featureKey+kind 分组才比较；keeper 取 id 最小（先落库者）；
 * 纯 dry-run 默认，--apply 才删。
 * 用法：npx tsx scripts/dedupe-release-changes.ts --repository <slug|id> [--release <id>] [--apply]
 */

export interface PlannableChangeRow {
  id: number;
  releaseId: number;
  featureName: string;
  kind: string;
  description: string;
}

export interface ChangeDedupePlan {
  releaseId: number;
  featureName: string;
  kind: string;
  keepId: number;
  dropIds: number[];
}

/** 纯函数（与执行分离）：同 release 同 featureKey+kind 内贪心去重，keeper=id 最小先落库者。 */
export function planChangesDedupe(rows: PlannableChangeRow[]): ChangeDedupePlan[] {
  const plans: ChangeDedupePlan[] = [];
  const groups = new Map<string, PlannableChangeRow[]>();
  for (const row of rows) {
    const key = `${row.releaseId}|${specFeatureKey(row.featureName)}|${row.kind}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  for (const [, list] of groups) {
    const sorted = [...list].sort((a, b) => a.id - b.id);
    const kept: PlannableChangeRow[] = [];
    const dropIds: number[] = [];
    for (const row of sorted) {
      const hit = kept.find((candidate) => changeDescriptionVariantSimilar(candidate.description, row.description));
      if (hit) {
        dropIds.push(row.id);
        continue;
      }
      kept.push(row);
    }
    if (dropIds.length > 0) {
      plans.push({ releaseId: sorted[0].releaseId, featureName: sorted[0].featureName, kind: sorted[0].kind, keepId: sorted[0].id, dropIds });
    }
  }
  return plans.sort((a, b) => a.releaseId - b.releaseId || a.featureName.localeCompare(b.featureName));
}

function parseArgs(argv: string[]) {
  const args: { repository: string; release: number | null; apply: boolean } = { repository: "", release: null, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repository") args.repository = argv[index + 1] ?? "";
    if (argv[index] === "--release") args.release = Number(argv[index + 1]);
    if (argv[index] === "--apply") args.apply = true;
  }
  if (!args.repository) {
    console.error("用法：npx tsx scripts/dedupe-release-changes.ts --repository <slug|id> [--release <id>] [--apply]");
    process.exit(1);
  }
  return args;
}

async function resolveRepository(db: Pool, repository: string): Promise<{ id: number; name: string } | null> {
  const column = /^\d+$/.test(repository) ? "id" : "name";
  const [rows] = await db.execute(`SELECT id, name FROM repositories WHERE ${column} = ? LIMIT 1`, [repository]);
  return ((rows as Array<{ id: number; name: string }>)[0]) ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = mysql.createPool(databaseConfig(true));
  try {
    const repository = await resolveRepository(db, args.repository);
    if (!repository) throw new Error(`仓库不存在：${args.repository}`);

    const releaseFilter = args.release ? "AND r.id = ?" : "";
    const parameters = args.release ? [repository.id, args.release] : [repository.id];
    const [rows] = await db.execute(
      `SELECT c.id, c.release_id AS releaseId, c.feature_name AS featureName, c.kind, c.description
       FROM changes c JOIN releases r ON r.id = c.release_id
       WHERE r.repository_id = ? ${releaseFilter}
       ORDER BY c.release_id, c.id`,
      parameters,
    );
    const changeRows = rows as PlannableChangeRow[];
    console.log(`仓库 ${repository.name}（#${repository.id}）：${changeRows.length} 条 changes 行`);

    const plans = planChangesDedupe(changeRows);
    if (plans.length === 0) {
      console.log("未发现可去重的变化条目变体。");
      return;
    }
    let dropTotal = 0;
    for (const plan of plans) {
      dropTotal += plan.dropIds.length;
      console.log(`\n[release #${plan.releaseId}] ${plan.featureName} (${plan.kind})`);
      console.log(`  保留 #${plan.keepId}`);
      for (const dropId of plan.dropIds) console.log(`  - 删除变体行 #${dropId}`);
    }
    console.log(`\n提案：${plans.length} 组、删除 ${dropTotal} 条变体行（changes 表无下游外键，历史 spec_changes/spec_versions 不涉及）。`);
    if (!args.apply) {
      console.log("dry-run 未改动数据；人工审阅后加 --apply 执行。");
      return;
    }
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      for (const plan of plans) {
        for (const dropId of plan.dropIds) {
          await connection.execute("DELETE FROM changes WHERE id = ?", [dropId]);
        }
      }
      await connection.commit();
      console.log(`\n已执行：删除 ${dropTotal} 条变体行（keep 各组首条）。`);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith("dedupe-release-changes.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
