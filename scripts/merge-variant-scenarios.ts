import "dotenv/config";
import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { scenarioVariantSimilar, type SpecScenario } from "../lib/spec-diff";

/**
 * BM-6/A4 存量清理：对指定仓库最新规格版本内的措辞变体场景做合并提案（dry-run 默认）。
 * 判定复用 lib/spec-diff 的 scenarioVariantSimilar（与运行时合并/折叠同一口径，宁漏勿错合）。
 * 守护：manual 功能/场景不碰；人工核实过的场景（spec_verifications）不碰。
 * 用法：npx tsx scripts/merge-variant-scenarios.ts --repository <slug|id> [--apply]
 * --apply 前必须人工审阅 dry-run 报告（账本写操作由用户拍板，agent 只产出提案）。
 */

interface ScenarioRowLike {
  id: number;
  featureId: number;
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: string;
  source: string;
}

function parseArgs(argv: string[]) {
  const args: { repository: string; apply: boolean } = { repository: "", apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--repository") args.repository = argv[index + 1] ?? "";
    if (argv[index] === "--apply") args.apply = true;
  }
  if (!args.repository) {
    console.error("用法：npx tsx scripts/merge-variant-scenarios.ts --repository <slug|id> [--apply]");
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

    const [versionRows] = await db.execute(
      "SELECT id FROM spec_versions WHERE repository_id = ? ORDER BY id DESC LIMIT 1",
      [repository.id],
    );
    const version = (versionRows as Array<{ id: number }>)[0];
    if (!version) throw new Error("该仓库没有规格版本");

    const [featureRows] = await db.execute(
      "SELECT id, name, source FROM spec_features WHERE spec_version_id = ? ORDER BY position",
      [version.id],
    );
    const features = featureRows as Array<{ id: number; name: string; source: string }>;

    const [scenarioRows] = await db.execute(
      `SELECT s.id, s.spec_feature_id AS featureId, s.reference, s.context, s.action, s.outcome, s.category, s.source
       FROM spec_scenarios s JOIN spec_features f ON f.id = s.spec_feature_id
       WHERE f.spec_version_id = ? ORDER BY s.spec_feature_id, s.id`,
      [version.id],
    );
    const scenarios = scenarioRows as ScenarioRowLike[];

    const [verificationRows] = await db.execute(
      "SELECT DISTINCT entity_id FROM spec_verifications WHERE entity_type = 'scenario'",
    );
    const verifiedIds = new Set((verificationRows as Array<{ entity_id: number }>).map((row) => row.entity_id));

    const featureName = new Map(features.map((feature) => [feature.id, feature.name]));
    const byFeature = new Map<number, ScenarioRowLike[]>();
    for (const scenario of scenarios) {
      const list = byFeature.get(scenario.featureId) ?? [];
      list.push(scenario);
      byFeature.set(scenario.featureId, list);
    }

    type Proposal = { featureId: number; pairs: Array<{ drop: ScenarioRowLike; keep: ScenarioRowLike }>; skipped: string[] };
    const proposals: Proposal[] = [];
    for (const [featureId, list] of byFeature) {
      const feature = features.find((candidate) => candidate.id === featureId);
      if (feature?.source === "manual") continue;
      const kept: ScenarioRowLike[] = [];
      const pairs: Array<{ drop: ScenarioRowLike; keep: ScenarioRowLike }> = [];
      const skipped: string[] = [];
      for (const scenario of list) {
        if (scenario.source === "manual" || verifiedIds.has(scenario.id)) {
          skipped.push(`${scenario.reference}(人工/已核实)`);
          continue;
        }
        const asSpec = scenario as unknown as SpecScenario;
        const hit = kept.find((candidate) => scenarioVariantSimilar(candidate as unknown as SpecScenario, asSpec));
        if (hit) {
          pairs.push({ drop: scenario, keep: hit });
          continue;
        }
        kept.push(scenario);
      }
      if (pairs.length > 0) proposals.push({ featureId, pairs, skipped });
    }

    console.log(`仓库 ${repository.name}（#${repository.id}）规格 v${version.id}：${scenarios.length} 场景 / ${byFeature.size} 功能`);
    if (proposals.length === 0) {
      console.log("未发现可合并的措辞变体。");
      return;
    }
    let dropTotal = 0;
    for (const proposal of proposals) {
      dropTotal += proposal.pairs.length;
      console.log(`\n【${featureName.get(proposal.featureId)}】`);
      for (const pair of proposal.pairs) console.log(`  - 删除 ${pair.drop.reference}(#${pair.drop.id}) → 并入 ${pair.keep.reference}(#${pair.keep.id})\n      情境：${pair.drop.context}\n      操作：${pair.drop.action}\n      结果：${pair.drop.outcome}`);
      for (const skip of proposal.skipped) console.log(`  ! 跳过 ${skip}`);
    }
    console.log(`\n提案：${proposals.length} 个功能、删除 ${dropTotal} 条变体场景。`);
    if (!args.apply) {
      console.log("dry-run 未改动数据；人工审阅后加 --apply 执行。");
      return;
    }
    const ids = proposals.flatMap((proposal) => proposal.pairs.map((pair) => pair.drop.id));
    const placeholders = ids.map(() => "?").join(",");
    const [result] = await db.execute(`DELETE FROM spec_scenarios WHERE id IN (${placeholders})`, ids);
    console.log(`已删除 ${(result as { affectedRows?: number }).affectedRows ?? ids.length} 条变体场景（历史 changes 的 before/after JSON 不动，审计保留）。`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
