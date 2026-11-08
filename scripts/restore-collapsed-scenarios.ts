import "dotenv/config";
import { existsSync } from "node:fs";
import { getDb } from "../lib/db";
import { loadVersionFeatureMap } from "../lib/spec-versions";
import { specChangeWordingOnly, specFeatureKey, type SpecFeature, type SpecScenario } from "../lib/spec-diff";

/**
 * 坍缩恢复（生产 v95 事故，2026-11-08）：从最近若干个 spec 快照里找回被提取坍缩丢掉的
 * generated 场景，回填到最新快照（carry-forward 的种子）与工作台。
 *
 * 判定口径：
 * - 基线 = 每个功能在回看窗口内场景数最多的版本（AI 对该功能最完整的知识）；
 * - 丢失 = 基线场景在最新版中没有行为等价项（category 相同 + context/action/outcome 等价，
 *   与运行时折叠判定同口径）；
 * - 证据过滤 = 场景的全部证据路径必须仍存在于工作副本（防复活已删除行为）；
 * - 引用冲突 = 基线 reference 与最新版占用冲突时按前缀重编号（HP-9 → HP-10）。
 *
 * 默认 dry-run；`--apply` 才写库。幂等：重复执行时候选已与最新版等价，自动跳过。
 */

const BASELINE_WINDOW = 12;

interface RestorePlan {
  featureName: string;
  scenarios: Array<{ reference: string; scenario: SpecScenario; sourceVersionId: number }>;
}

/** 前缀重编号：取同前缀现有最大序号 +1（HP-1/EC-2/ER-3 → HP-4 这类）。 */
export function nextReference(used: string[], reference: string) {
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

export function planRestores(
  current: SpecFeature[],
  baselines: Map<number, SpecFeature[]>,
  fileExists: (path: string) => boolean,
): { plans: RestorePlan[]; skippedMissingFiles: number } {
  const plans: RestorePlan[] = [];
  let skippedMissingFiles = 0;
  for (const feature of current) {
    const key = specFeatureKey(feature.name);
    // 基线 = 回看窗口内该功能场景数最多的版本
    let best: { versionId: number; feature: SpecFeature } | null = null;
    for (const [versionId, features] of baselines) {
      const baselineFeature = features.find((candidate) => specFeatureKey(candidate.name) === key);
      if (!baselineFeature) continue;
      if (!best || baselineFeature.scenarios.length > best.feature.scenarios.length) {
        best = { versionId, feature: baselineFeature };
      }
    }
    if (!best || best.feature.scenarios.length <= feature.scenarios.length) continue;

    const usedReferences = feature.scenarios.map((scenario) => scenario.reference);
    const scenarios: RestorePlan["scenarios"] = [];
    for (const candidate of best.feature.scenarios) {
      const equivalent = feature.scenarios.some((existing) => specChangeWordingOnly(candidate, existing));
      if (equivalent) continue;
      const evidence = candidate.evidence ?? [];
      if (!evidence.every((item) => fileExists(item.path))) {
        skippedMissingFiles += 1;
        continue;
      }
      const reference = usedReferences.includes(candidate.reference)
        ? nextReference(usedReferences, candidate.reference)
        : candidate.reference;
      usedReferences.push(reference);
      scenarios.push({ reference, scenario: candidate, sourceVersionId: best.versionId });
    }
    if (scenarios.length === 0) continue;
    plans.push({ featureName: feature.name, scenarios });
  }
  return { plans, skippedMissingFiles };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const slug = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "codelphi";
  const db = getDb();
  try {
    const [productRows] = await db.execute(
      `SELECT p.id AS productId, r.id AS repositoryId FROM products p JOIN repositories r ON r.product_id = p.id WHERE p.slug = ? LIMIT 1`,
      [slug],
    ) as [Array<{ productId: number; repositoryId: number }>, unknown];
    const product = productRows[0];
    if (!product) throw new Error(`product not found: ${slug}`);

    const [versionRows] = await db.execute(
      "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT ?",
      [product.repositoryId, BASELINE_WINDOW + 1],
    ) as [Array<{ id: number }>, unknown];
    const versionIds = versionRows.map((row) => Number(row.id));
    if (versionIds.length === 0) throw new Error("no spec versions");
    const latestId = versionIds[0];
    const baselineIds = versionIds.slice(1);

    const executeWrapper = (statement: string, parameters: Array<string | number | null>) => db.execute(statement, parameters);
    const versionMap = await loadVersionFeatureMap(executeWrapper, versionIds);
    const current = versionMap.get(latestId) ?? [];
    const baselines = new Map(baselineIds.map((id) => [id, versionMap.get(id) ?? []]));

    const { plans, skippedMissingFiles } = planRestores(current, baselines, (path) => existsSync(path));
    const totalRestores = plans.reduce((total, plan) => total + plan.scenarios.length, 0);
    console.log(`latest version ${latestId}; baseline window ${baselineIds.join(",")}`);
    for (const plan of plans) {
      console.log(`  ${plan.featureName}: +${plan.scenarios.length} (from v${plan.scenarios[0].sourceVersionId})`);
      for (const item of plan.scenarios) console.log(`    ${item.reference}: ${item.scenario.outcome.slice(0, 60)}`);
    }
    console.log(`restores=${totalRestores} skippedMissingFiles=${skippedMissingFiles}${apply ? "" : " (dry-run)"}`);
    if (!apply || totalRestores === 0) return;

    // 工作台 feature 行按名称匹配（全部目标功能当前都存在；缺失则跳过该功能并报告）
    const [featureRows] = await db.execute(
      `SELECT id, name FROM features WHERE product_id = ? AND active = 1`,
      [product.productId],
    ) as [Array<{ id: number; name: string }>, unknown];
    const workbenchByName = new Map(featureRows.map((row) => [specFeatureKey(row.name), Number(row.id)]));

    for (const plan of plans) {
      const [snapshotRows] = await db.execute(
        "SELECT id FROM spec_features WHERE spec_version_id = ? AND name = ? LIMIT 1",
        [latestId, plan.featureName],
      ) as [Array<{ id: number }>, unknown];
      const specFeatureId = snapshotRows[0] ? Number(snapshotRows[0].id) : null;
      const workbenchFeatureId = workbenchByName.get(specFeatureKey(plan.featureName)) ?? null;
      if (!specFeatureId || !workbenchFeatureId) {
        console.warn(`  skip ${plan.featureName}: snapshot=${specFeatureId} workbench=${workbenchFeatureId}`);
        continue;
      }
      for (const item of plan.scenarios) {
        const payload = [item.scenario.context, item.scenario.action, item.scenario.outcome, item.scenario.category, JSON.stringify(item.scenario.evidence)];
        await db.execute(
          `INSERT INTO spec_scenarios (spec_feature_id, reference, context, action, outcome, category, source, evidence)
           VALUES (?, ?, ?, ?, ?, ?, 'generated', ?)`,
          [specFeatureId, item.reference, ...payload],
        );
        // 工作台唯一键含非活跃行（upsertGeneratedSpec 每轮下线不删行）：同引用旧行 = 被
        // 下线的历史条目，直接复活并写入恢复内容；活跃行冲突不会到达此处（已按快照引用重编号）。
        await db.execute(
          `INSERT INTO scenarios (feature_id, reference, context, action, outcome, category, source, active, evidence)
           VALUES (?, ?, ?, ?, ?, ?, 'generated', 1, ?)
           ON DUPLICATE KEY UPDATE context = VALUES(context), action = VALUES(action), outcome = VALUES(outcome),
             category = VALUES(category), evidence = VALUES(evidence), active = 1`,
          [workbenchFeatureId, item.reference, ...payload],
        );
      }
      console.log(`  applied ${plan.featureName}: +${plan.scenarios.length}`);
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1]?.endsWith("restore-collapsed-scenarios.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
