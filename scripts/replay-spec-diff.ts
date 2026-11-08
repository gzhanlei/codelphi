import "dotenv/config";
import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { diffSpecWithFolded, type SpecFeature, type SpecScenario } from "../lib/spec-diff";

/**
 * 运维工具：用当前 diffSpecWithFolded 逻辑重放两个规格版本之间的行为 diff，
 * 用于验证折叠机制对历史窗口的效果（如 superset 第三方盲评的误报复盘）。
 * 用法：npx tsx scripts/replay-spec-diff.ts <beforeSpecVersionId> <afterSpecVersionId>
 */
async function loadFeatures(db: Pool, versionId: number): Promise<SpecFeature[]> {
  const [featureRows] = await db.execute(
    "SELECT id, name, summary, parent_key AS parentKey FROM spec_features WHERE spec_version_id = ? ORDER BY id",
    [versionId],
  ) as [Array<{ id: number; name: string; summary: string; parentKey: string | null }>, unknown];
  const [scenarioRows] = await db.execute(
    `SELECT ss.spec_feature_id AS featureId, ss.reference, ss.context, ss.action, ss.outcome, ss.category
     FROM spec_scenarios ss
     WHERE ss.spec_feature_id IN (SELECT id FROM spec_features WHERE spec_version_id = ?)
     ORDER BY ss.id`,
    [versionId],
  ) as [Array<{ featureId: number; reference: string; context: string; action: string; outcome: string; category: string }>, unknown];
  return featureRows.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    parentKey: feature.parentKey,
    scenarios: scenarioRows
      .filter((scenario) => scenario.featureId === feature.id)
      .map((scenario): SpecScenario => ({ ...scenario, category: scenario.category as SpecScenario["category"], evidence: [] })),
  }));
}

async function main() {
  const [beforeId, afterId] = [Number(process.argv[2]), Number(process.argv[3])];
  if (!beforeId || !afterId) throw new Error("用法：npx tsx scripts/replay-spec-diff.ts <beforeSpecVersionId> <afterSpecVersionId>");
  const db = mysql.createPool(databaseConfig(true));
  try {
    const before = await loadFeatures(db, beforeId);
    const after = await loadFeatures(db, afterId);
    const outcome = diffSpecWithFolded(before, after);
    console.log(`v${beforeId}（${before.length} 功能）→ v${afterId}（${after.length} 功能）`);
    console.log(`行为变化 ${outcome.changes.length} 条，折叠 ${outcome.folded.length} 条\n`);
    for (const change of outcome.changes) {
      console.log(`[变化] ${change.kind}:${change.entityType} ${change.featureName}${change.scenarioReference ? ` · ${change.scenarioReference}` : ""}`);
    }
    for (const folded of outcome.folded) {
      console.log(`[折叠:${folded.reason}] ${folded.entityType} ${folded.featureName}${folded.scenarioReference ? ` · ${folded.scenarioReference}` : ""}`);
    }
  } finally {
    await db.end();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
