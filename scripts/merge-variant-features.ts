import "dotenv/config";
import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { featureScenarioPairMatch, featureVariantSimilar, type SpecFeature, type SpecScenario } from "../lib/spec-diff";

/**
 * BM-11 存量清理：把跨 run 重建出的功能级变体（「无壳页面语言切换」vs「无外壳页面语言
 * 切换」、release 220 的支付面板 ×4）合并进 keeper 功能。判定复用 lib/spec-diff 的
 * featureVariantSimilar（与运行时装配折叠同一口径，宁漏勿错合）。
 * 范围：最新 spec 快照（spec_features/spec_scenarios）+ 工作台 active 特征（features/scenarios）。
 * 守护：manual 功能/场景不碰；人工核实过的场景只搬不删；工作台变体软下线（active=0）不删行；
 * 历史 spec_changes 不动（A4 审计口径）。
 * 用法：npx tsx scripts/merge-variant-features.ts --repository <slug|id> [--apply]
 * --apply 前必须人工审阅 dry-run 报告（账本写操作由用户拍板，agent 只产出提案）。
 */

export interface PlannableScenario {
  id: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: string;
  source: string;
  /** 人工核实过（spec_verifications 命中）——只搬不删。 */
  verified?: boolean;
}

export interface PlannableFeature {
  id: number;
  name: string;
  summary: string;
  source: string;
  scenarios: PlannableScenario[];
}

export interface ScenarioMove {
  scenarioId: number;
  reference: string;
  /** keeper 已占用该引用，搬入时按 nextReference 重编号后的值。 */
  newReference: string | null;
  /** 行为与 keeper 既有场景重复→删除；否则搬入 keeper。 */
  drop: boolean;
}

export interface FeatureMergePlan {
  keeperId: number;
  keeperName: string;
  variantId: number;
  variantName: string;
  moves: ScenarioMove[];
}

const asSpecScenario = (scenario: PlannableScenario): SpecScenario =>
  ({ ...scenario, category: scenario.category as SpecScenario["category"], evidence: [], step: null }) as SpecScenario;

const asSpecFeature = (feature: PlannableFeature): SpecFeature =>
  ({ name: feature.name, summary: feature.summary, scenarios: feature.scenarios.map(asSpecScenario) }) as unknown as SpecFeature;

/**
 * 纯函数规划（与执行分离，restore-collapsed-scenarios 模式）：features 按调用方给的
 * keeper 优先序排列（快照按 position、工作台按 id 升序=最老优先），先到者为 keeper。
 * manual 功能既不作为折叠目标也不被折叠；scenario 级重复按 featureScenarioPairMatch 判定，
 * manual/已核实场景即使重复也只搬不删（保数据，改引用避冲突）。
 */
export function planFeatureMerges(features: PlannableFeature[]): FeatureMergePlan[] {
  const plans: FeatureMergePlan[] = [];
  const kept: PlannableFeature[] = [];
  for (const feature of features) {
    if (feature.source === "manual") {
      kept.push(feature);
      continue;
    }
    const target = kept.find((candidate) => candidate.source !== "manual" && featureVariantSimilar(asSpecFeature(candidate), asSpecFeature(feature)));
    if (!target) {
      kept.push(feature);
      continue;
    }
    const keeperReferences = target.scenarios.map((scenario) => scenario.reference);
    const moves: ScenarioMove[] = [];
    for (const scenario of feature.scenarios) {
      const asSpec = asSpecScenario(scenario);
      const duplicate = target.scenarios.some((existing) => featureScenarioPairMatch(asSpecScenario(existing), asSpec));
      if (duplicate && scenario.source !== "manual" && !scenario.verified) {
        moves.push({ scenarioId: scenario.id, reference: scenario.reference, newReference: null, drop: true });
        continue;
      }
      const newReference = keeperReferences.includes(scenario.reference)
        ? nextReferenceFor(keeperReferences, scenario.reference)
        : null;
      if (newReference) keeperReferences.push(newReference);
      else keeperReferences.push(scenario.reference);
      target.scenarios.push({ ...scenario, reference: newReference ?? scenario.reference });
      moves.push({ scenarioId: scenario.id, reference: scenario.reference, newReference, drop: false });
    }
    plans.push({ keeperId: target.id, keeperName: target.name, variantId: feature.id, variantName: feature.name, moves });
  }
  return plans;
}

/** 与 lib/extraction-merge nextReference 同语义的本地副本（脚本不 import 运行时合并层，避免拉入 ai 依赖链）。 */
function nextReferenceFor(used: string[], reference: string): string {
  const match = reference.match(/^([A-Za-z]+)-(\d+)$/);
  if (!match) return reference;
  const [, prefix] = match;
  let max = 0;
  for (const item of used) {
    const itemMatch = item.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (itemMatch) max = Math.max(max, Number(itemMatch[1]));
  }
  return `${prefix}-${max + 1}`;
}

function parseArgs(argv: string[]) {
  const args: { repository: string; apply: boolean } = { repository: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repository") args.repository = argv[index + 1] ?? "";
    if (argv[index] === "--apply") args.apply = true;
  }
  if (!args.repository) {
    console.error("用法：npx tsx scripts/merge-variant-features.ts --repository <slug|id> [--apply]");
    process.exit(1);
  }
  return args;
}

async function resolveRepository(db: Pool, repository: string): Promise<{ id: number; productId: number; name: string } | null> {
  const column = /^\d+$/.test(repository) ? "id" : "name";
  const [rows] = await db.execute(`SELECT id, product_id AS productId, name FROM repositories WHERE ${column} = ? LIMIT 1`, [repository]);
  return ((rows as Array<{ id: number; productId: number; name: string }>)[0]) ?? null;
}

async function loadVerifiedScenarioIds(db: Pool): Promise<Set<number>> {
  const [rows] = await db.execute("SELECT DISTINCT entity_id FROM spec_verifications WHERE entity_type = 'scenario'");
  return new Set((rows as Array<{ entity_id: number }>).map((row) => Number(row.entity_id)));
}

async function loadSnapshotFeatures(db: Pool, versionId: number, verifiedIds: Set<number>): Promise<PlannableFeature[]> {
  const [featureRows] = await db.execute(
    "SELECT id, name, summary, source FROM spec_features WHERE spec_version_id = ? ORDER BY position",
    [versionId],
  );
  const features = featureRows as Array<{ id: number; name: string; summary: string; source: string }>;
  const [scenarioRows] = await db.execute(
    `SELECT s.id, s.spec_feature_id AS featureId, s.reference, s.context, s.action, s.outcome, s.category, s.source
     FROM spec_scenarios s JOIN spec_features f ON f.id = s.spec_feature_id
     WHERE f.spec_version_id = ? ORDER BY s.spec_feature_id, s.id`,
    [versionId],
  );
  return features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    summary: feature.summary,
    source: feature.source,
    scenarios: (scenarioRows as Array<{ id: number; featureId: number; reference: string; context: string; action: string; outcome: string; category: string; source: string }>)
      .filter((scenario) => scenario.featureId === feature.id)
      .map((scenario) => ({ ...scenario, verified: verifiedIds.has(scenario.id) })),
  }));
}

async function loadWorkbenchFeatures(db: Pool, productId: number): Promise<PlannableFeature[]> {
  const [featureRows] = await db.execute(
    "SELECT id, name, summary, source FROM features WHERE product_id = ? AND active = 1 ORDER BY id",
    [productId],
  );
  const features = featureRows as Array<{ id: number; name: string; summary: string; source: string }>;
  if (features.length === 0) return [];
  const ids = features.map((feature) => feature.id);
  const placeholders = ids.map(() => "?").join(",");
  const [scenarioRows] = await db.execute(
    `SELECT id, feature_id AS featureId, reference, context, action, outcome, category, source
     FROM scenarios WHERE feature_id IN (${placeholders}) AND active = 1 ORDER BY feature_id, id`,
    ids,
  );
  return features.map((feature) => ({
    id: feature.id,
    name: feature.name,
    summary: feature.summary,
    source: feature.source,
    scenarios: (scenarioRows as Array<{ id: number; featureId: number; reference: string; context: string; action: string; outcome: string; category: string; source: string }>)
      .filter((scenario) => scenario.featureId === feature.id)
      .map((scenario) => ({ ...scenario })),
  }));
}

async function cascadeVictims(db: Pool, variantIds: number[]): Promise<Array<{ table: string; count: number }>> {
  if (variantIds.length === 0) return [];
  const placeholders = variantIds.map(() => "?").join(",");
  const checks: Array<[string, string]> = [
    ["spec_file_index", `SELECT COUNT(*) AS count FROM spec_file_index WHERE spec_feature_id IN (${placeholders})`],
    ["spec_feature_flows", `SELECT COUNT(*) AS count FROM spec_feature_flows WHERE spec_feature_id IN (${placeholders})`],
    ["regression_tasks(经场景)", `SELECT COUNT(*) AS count FROM regression_tasks WHERE spec_scenario_id IN (SELECT id FROM spec_scenarios WHERE spec_feature_id IN (${placeholders}))`],
  ];
  const victims: Array<{ table: string; count: number }> = [];
  for (const [table, sql] of checks) {
    const [rows] = await db.execute(sql, variantIds);
    victims.push({ table, count: Number((rows as Array<{ count: number }>)[0]?.count ?? 0) });
  }
  return victims;
}

function printPlans(label: string, plans: FeatureMergePlan[]) {
  console.log(`\n== ${label} ==`);
  if (plans.length === 0) {
    console.log("未发现可合并的功能级变体。");
    return;
  }
  let dropTotal = 0;
  let moveTotal = 0;
  for (const plan of plans) {
    const drops = plan.moves.filter((move) => move.drop);
    const moves = plan.moves.filter((move) => !move.drop);
    dropTotal += drops.length;
    moveTotal += moves.length;
    console.log(`【${plan.variantName}】(#${plan.variantId}) → 并入【${plan.keeperName}】(#${plan.keeperId})`);
    for (const move of drops) console.log(`  - 删场景 ${move.reference}(#${move.scenarioId})（与 keeper 行为重复）`);
    for (const move of moves) console.log(`  - 搬场景 ${move.reference}(#${move.scenarioId})${move.newReference ? ` → 重编号 ${move.newReference}` : ""}`);
  }
  console.log(`小计：${plans.length} 个变体功能、搬 ${moveTotal} 条场景、删 ${dropTotal} 条重复场景。`);
}

async function applySnapshotPlans(connection: PoolConnection, plans: FeatureMergePlan[]) {
  for (const plan of plans) {
    for (const move of plan.moves) {
      if (move.drop) {
        await connection.execute("DELETE FROM spec_scenarios WHERE id = ?", [move.scenarioId]);
        continue;
      }
      if (move.newReference) {
        await connection.execute("UPDATE spec_scenarios SET spec_feature_id = ?, reference = ? WHERE id = ?", [plan.keeperId, move.newReference, move.scenarioId]);
      } else {
        await connection.execute("UPDATE spec_scenarios SET spec_feature_id = ? WHERE id = ?", [plan.keeperId, move.scenarioId]);
      }
    }
    await connection.execute("DELETE FROM spec_features WHERE id = ?", [plan.variantId]);
  }
}

async function applyWorkbenchPlans(connection: PoolConnection, productId: number, plans: FeatureMergePlan[], aliasRows: Array<{ aliasKey: string; canonicalKey: string }>) {
  for (const plan of plans) {
    for (const move of plan.moves) {
      if (move.drop) {
        await connection.execute("DELETE FROM scenarios WHERE id = ?", [move.scenarioId]);
        continue;
      }
      if (move.newReference) {
        await connection.execute("UPDATE scenarios SET feature_id = ?, reference = ? WHERE id = ?", [plan.keeperId, move.newReference, move.scenarioId]);
      } else {
        await connection.execute("UPDATE scenarios SET feature_id = ? WHERE id = ?", [plan.keeperId, move.scenarioId]);
      }
    }
    // 工作台软下线：保留名称占位与历史，不 DELETE（feature_aliases 登记显式归并）。
    await connection.execute("UPDATE features SET active = 0 WHERE id = ?", [plan.variantId]);
  }
  for (const alias of aliasRows) {
    await connection.execute(
      "INSERT IGNORE INTO feature_aliases (product_id, alias_key, canonical_key) VALUES (?, ?, ?)",
      [productId, alias.aliasKey, alias.canonicalKey],
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = mysql.createPool(databaseConfig(true));
  try {
    const repository = await resolveRepository(db, args.repository);
    if (!repository) throw new Error(`仓库不存在：${args.repository}`);

    const [versionRows] = await db.execute(
      "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
      [repository.id],
    );
    const version = (versionRows as Array<{ id: number }>)[0];
    if (!version) throw new Error("该仓库没有规格版本");

    const verifiedIds = await loadVerifiedScenarioIds(db);
    const snapshotFeatures = await loadSnapshotFeatures(db, version.id, verifiedIds);
    const workbenchFeatures = await loadWorkbenchFeatures(db, repository.productId);

    const snapshotPlans = planFeatureMerges(snapshotFeatures);
    const workbenchPlans = planFeatureMerges(workbenchFeatures);

    console.log(`仓库 ${repository.name}（#${repository.id}）规格 v${version.id}：快照 ${snapshotFeatures.length} 功能 / 工作台 ${workbenchFeatures.length} active 功能`);
    printPlans(`最新快照（spec_features v${version.id}）`, snapshotPlans);
    printPlans("工作台（features active=1）", workbenchPlans);

    const variantIds = snapshotPlans.map((plan) => plan.variantId);
    const victims = await cascadeVictims(db, variantIds);
    const victimTotal = victims.reduce((sum, victim) => sum + victim.count, 0);
    if (victimTotal > 0) {
      console.log("\n⚠ 删除快照变体功能行将连带清空（ON DELETE CASCADE，dry-run 如实列出）：");
      for (const victim of victims) console.log(`  - ${victim.table}: ${victim.count} 行`);
    }

    if (snapshotPlans.length === 0 && workbenchPlans.length === 0) return;
    if (!args.apply) {
      console.log("\ndry-run 未改动数据；人工审阅后加 --apply 执行。");
      return;
    }

    const aliasRows = snapshotPlans.map((plan) => ({ aliasKey: plan.variantName.trim().toLowerCase().replace(/\s+/g, " "), canonicalKey: plan.keeperName.trim().toLowerCase().replace(/\s+/g, " ") }));
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      await applySnapshotPlans(connection, snapshotPlans);
      await applyWorkbenchPlans(connection, repository.productId, workbenchPlans, aliasRows);
      await connection.commit();
      console.log(`\n已执行：快照合并 ${snapshotPlans.length} 个变体功能、工作台软下线 ${workbenchPlans.length} 个、feature_aliases 登记 ${aliasRows.length} 条。历史 spec_changes 不动（审计保留）。`);
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

if (process.argv[1]?.endsWith("merge-variant-features.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
