#!/usr/bin/env tsx
/**
 * 可用率试验的数据导出（规格 §19.4）：把生产库里指定仓库每个发布版本的自动功能与证据锚点
 * 导成 JSON Lines，试验脚本离线重放。
 *
 * 只读：只执行 SELECT。不导出场景正文，一行里只有功能键、证据路径和行号。
 *
 * 这个脚本要送进生产的一次性 migrate 容器执行，那里只有已部署的代码，所以除了 lib/db 与
 * lib/evidence 不依赖任何别的模块。脚本在容器里落在 /app/q.ts，发送时把 `../lib/` 改写成
 * `./lib/`。仓库列表从环境变量 TRIAL_REPOSITORY_IDS 读取，逗号分隔。
 */
import { pathToFileURL } from "node:url";
import { evidenceItems } from "../lib/evidence";

export interface FeatureRow {
  id: number;
  stable_key: string;
  source: string;
}

export interface ScenarioRow {
  spec_feature_id: number;
  source: string;
  evidence: unknown;
}

export interface ReleaseRow {
  repository_id: number;
  sha: string;
  spec_version_id: number | null;
}

export type FeatureRecord = [id: number, key: string];
/** [功能键, 证据路径, 起始行, 结束行]。只有起始行的锚点，结束行取起始行；没有行号时两个都是 null。 */
export type AnchorRecord = [featureKey: string, path: string, startLine: number | null, endLine: number | null];

export interface LedgerLine {
  repositoryId: number;
  sha: string;
  versionId: number;
  features: FeatureRecord[];
  anchors: AnchorRecord[];
}

const isAutomatic = (source: string) => source !== "manual";

/**
 * 与 `rebuildSpecFileIndex` 同一条规则（场景证据里的每个路径），但只取自动功能：
 * manual 条目不参与集合运算（规格 §9.1）。
 */
function automaticKeys(features: readonly FeatureRow[]): Map<number, string> {
  const keyOf = new Map<number, string>();
  for (const feature of features) {
    if (isAutomatic(feature.source)) keyOf.set(Number(feature.id), feature.stable_key);
  }
  return keyOf;
}

function anchorsUnder(scenarios: readonly ScenarioRow[], keyOf: ReadonlyMap<number, string>): AnchorRecord[] {
  const anchors: AnchorRecord[] = [];
  for (const scenario of scenarios) {
    const featureKey = keyOf.get(Number(scenario.spec_feature_id));
    if (!featureKey || !isAutomatic(scenario.source)) continue;
    for (const item of evidenceItems(scenario.evidence)) {
      if (!item.path) continue;
      const startLine = item.startLine ?? null;
      anchors.push([featureKey, item.path, startLine, item.endLine ?? startLine]);
    }
  }
  return anchors;
}

export function toLedgerLine(release: ReleaseRow, features: readonly FeatureRow[], scenarios: readonly ScenarioRow[]): LedgerLine | null {
  if (release.spec_version_id === null) return null;
  const keyOf = automaticKeys(features);
  return {
    repositoryId: Number(release.repository_id),
    sha: release.sha,
    versionId: Number(release.spec_version_id),
    features: [...keyOf].map(([id, key]) => [id, key]),
    anchors: anchorsUnder(scenarios, keyOf),
  };
}

async function main(): Promise<void> {
  const repositoryIds = (process.env.TRIAL_REPOSITORY_IDS ?? "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);
  if (repositoryIds.length === 0) throw new Error("环境变量 TRIAL_REPOSITORY_IDS 没有给出任何仓库 id");
  const { getDb } = await import("../lib/db");
  const db = getDb();
  for (const repositoryId of repositoryIds) {
    const [releases] = (await db.execute(
      "SELECT repository_id, sha, spec_version_id FROM releases WHERE repository_id = ? ORDER BY committed_at, id",
      [repositoryId],
    )) as [ReleaseRow[], unknown];
    for (const release of releases) {
      if (release.spec_version_id === null) continue;
      const [features] = (await db.execute(
        "SELECT id, stable_key, source FROM spec_features WHERE spec_version_id = ? ORDER BY id",
        [release.spec_version_id],
      )) as [FeatureRow[], unknown];
      const [scenarios] = (await db.execute(
        "SELECT ss.spec_feature_id, ss.source, ss.evidence FROM spec_scenarios ss JOIN spec_features sf ON sf.id = ss.spec_feature_id WHERE sf.spec_version_id = ? ORDER BY ss.id",
        [release.spec_version_id],
      )) as [ScenarioRow[], unknown];
      const line = toLedgerLine(release, features, scenarios);
      if (line) process.stdout.write(`${JSON.stringify(line)}\n`);
    }
  }
  await db.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    () => process.exit(0),
    (error) => {
      console.error(String(error));
      process.exit(1);
    },
  );
}
