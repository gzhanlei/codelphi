import "dotenv/config";
import mysql, { type Pool } from "mysql2/promise";
import { databaseConfig } from "../lib/database-config";
import { compareDiffPairing, diffSpecWithFolded, type DiffPairingComparison, type SpecFeature, type SpecScenario } from "../lib/spec-diff";
import type { Execute } from "../lib/db";
import { loadVersionIdentities } from "../lib/spec-identity-store";

/**
 * 运维工具：用当前 diffSpecWithFolded 逻辑重放两个规格版本之间的行为 diff，
 * 用于验证折叠机制对历史窗口的效果（如 superset 第三方盲评的误报复盘）。
 * 用法：npx tsx scripts/replay-spec-diff.ts <beforeSpecVersionId> <afterSpecVersionId> [releaseId] [--compare]
 *
 * --compare：同两个版本分别按名称键和按身份各比对一遍，报告两者是否逐项相同、哪里不同。
 * 身份层上线前后，身份和名称连续一致的版本对，两种配对的结果必须逐项相同。
 */

export interface ReplayArgs {
  beforeId: number;
  afterId: number;
  releaseId: number | null;
  compare: boolean;
}

const USAGE = "用法：npx tsx scripts/replay-spec-diff.ts <beforeSpecVersionId> <afterSpecVersionId> [releaseId] [--compare]";

export function parseReplayArgs(argv: readonly string[]): ReplayArgs {
  const positional: number[] = [];
  let compare = false;
  for (const argument of argv) {
    if (argument === "--compare") compare = true;
    else if (argument.startsWith("-")) throw new Error(`不认识的参数：${argument}。${USAGE}`);
    else if (/^\d+$/.test(argument)) positional.push(Number(argument));
    else throw new Error(`参数要填版本号，收到的是：${argument}。${USAGE}`);
  }
  if (positional.length < 2 || positional.length > 3) throw new Error(USAGE);
  return { beforeId: positional[0], afterId: positional[1], releaseId: positional[2] ?? null, compare };
}

const outlineOf = (outcome: DiffPairingComparison["byName"]) => [
  ...outcome.changes.map((change) => `[变化] ${change.kind}:${change.entityType} ${change.featureName}${change.scenarioReference ? ` · ${change.scenarioReference}` : ""}`),
  ...outcome.folded.map((folded) => `[折叠:${folded.reason}] ${folded.entityType} ${folded.featureName}${folded.scenarioReference ? ` · ${folded.scenarioReference}` : ""}`),
];

/** 把行数成多重集合：同一行可能出现不止一次。 */
function tally(lines: readonly string[]): Map<string, number> {
  return lines.reduce((total, line) => total.set(line, (total.get(line) ?? 0) + 1), new Map<string, number>());
}

/** lines 里扣掉 other 里也有的行之后剩下的。 */
function onlyIn(lines: readonly string[], other: ReadonlyMap<string, number>): string[] {
  const remaining = new Map(other);
  const result: string[] = [];
  for (const line of lines) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else result.push(line);
  }
  return result;
}

/** 两种配对的差别：只在一种结果里出现的行。相同时是空数组。 */
export function pairingDifferences(comparison: DiffPairingComparison): string[] {
  if (comparison.same) return [];
  const byName = outlineOf(comparison.byName);
  const byIdentity = outlineOf(comparison.byIdentity);
  return [
    ...onlyIn(byName, tally(byIdentity)).map((line) => `只按名称键配对时有：${line}`),
    ...onlyIn(byIdentity, tally(byName)).map((line) => `只按身份配对时有：${line}`),
  ];
}

export function renderComparison(comparison: DiffPairingComparison): string {
  const lines = [
    `按名称键配对：行为变化 ${comparison.byName.changes.length} 条，折叠 ${comparison.byName.folded.length} 条`,
    `按身份配对：行为变化 ${comparison.byIdentity.changes.length} 条，折叠 ${comparison.byIdentity.folded.length} 条`,
  ];
  if (comparison.same) return [...lines, "两种配对逐项相同。"].join("\n");
  return [...lines, "两种配对的结果不同：", ...pairingDifferences(comparison).map((difference) => `- ${difference}`)].join("\n");
}

async function loadFeatures(db: Pool, versionId: number): Promise<SpecFeature[]> {
  const [featureRows] = await db.execute(
    "SELECT id, name, summary, parent_key AS parentKey FROM spec_features WHERE spec_version_id = ? ORDER BY id",
    [versionId],
  ) as [Array<{ id: number; name: string; summary: string; parentKey: string | null }>, unknown];
  const [scenarioRows] = await db.execute(
    `SELECT ss.spec_feature_id AS featureId, ss.reference, ss.context, ss.action, ss.outcome, ss.category, ss.evidence
     FROM spec_scenarios ss
     WHERE ss.spec_feature_id IN (SELECT id FROM spec_features WHERE spec_version_id = ?)
     ORDER BY ss.id`,
    [versionId],
  ) as [Array<{ featureId: number; reference: string; context: string; action: string; outcome: string; category: string; evidence: unknown }>, unknown];
  return featureRows.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    parentKey: feature.parentKey,
    scenarios: scenarioRows
      .filter((scenario) => scenario.featureId === feature.id)
      .map((scenario): SpecScenario => ({
        ...scenario,
        category: scenario.category as SpecScenario["category"],
        evidence: Array.isArray(scenario.evidence) ? scenario.evidence as SpecScenario["evidence"] : [],
      })),
  }));
}

async function main() {
  const args = parseReplayArgs(process.argv.slice(2));
  const db = mysql.createPool(databaseConfig(true));
  try {
    const before = await loadFeatures(db, args.beforeId);
    const after = await loadFeatures(db, args.afterId);
    let behavioral: Set<string> | undefined;
    if (args.releaseId) {
      const [rows] = await db.execute(
        "SELECT path FROM release_files WHERE behavioral_change = 1 AND release_id = ?",
        [args.releaseId],
      ) as [Array<{ path: string }>, unknown];
      behavioral = new Set(rows.map((row) => row.path));
      console.log(`使用 release ${args.releaseId} 的行为变更文件集（${behavioral.size} 个）`);
    }
    console.log(`v${args.beforeId}（${before.length} 功能）→ v${args.afterId}（${after.length} 功能）`);
    if (args.compare) {
      const execute: Execute = (statement, parameters) => db.execute(statement, parameters);
      const [beforeIdentities, afterIdentities] = await Promise.all([loadVersionIdentities(args.beforeId, execute), loadVersionIdentities(args.afterId, execute)]);
      console.log(`功能身份：v${args.beforeId} ${beforeIdentities.features.size} 个，v${args.afterId} ${afterIdentities.features.size} 个`);
      console.log(renderComparison(compareDiffPairing(before, after, {
        ...(behavioral ? { behavioralChangePaths: behavioral } : {}),
        identities: { before: beforeIdentities.features, after: afterIdentities.features },
      })));
      return;
    }
    const outcome = diffSpecWithFolded(before, after, behavioral ? { behavioralChangePaths: behavioral } : undefined);
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

// 只在直接运行时执行：测试要导入上面的纯函数，不能一导入就连库。
if (process.argv[1]?.endsWith("replay-spec-diff.ts")) {
  main().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
