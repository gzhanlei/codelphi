import { defaultExecute, type Execute } from "./db";
import { specFeatureKey } from "./spec-diff";
import { likePattern } from "./spec-search";

/**
 * B3 feature 连接图（确定性层，docs/specsight-gap-improvement-plan.md §5.3）：
 * 共享证据文件 → `Shares data`（同向有语义争议，先统一标注「共享证据面」）。
 * 只做功能之间的关系，不复活架构图（非目标）；LLM 推断层（Leads to / Triggers）
 * 不在本层——每条连接都带依据（共享文件清单），可点开核查。
 * LLM 补充层与错误率记录待第一版真实使用数据后再评估。
 */

export interface FeatureConnection {
  sourceFeatureId: number;
  sourceFeatureName: string;
  targetFeatureId: number;
  targetFeatureName: string;
  /** 共享的实现文件（按共享场景引用数排序，截前 5）。 */
  sharedFiles: Array<{ path: string; sourceScenarios: string[]; targetScenarios: string[] }>;
}

export interface FeatureConnectionEntry {
  featureId: number;
  featureName: string;
  connections: FeatureConnection[];
}

export interface ScenarioEvidenceRow {
  id: number;
  featureId: number;
  featureName: string;
  reference: string;
  evidence: unknown;
  /** 场景四段文本与来源：文件反查（buildFileImpact）需要；连接图构建忽略。 */
  context?: string;
  action?: string;
  outcome?: string;
  source?: string;
}

/** 文件反查单功能命中：scenarios 截前 N 条，scenarioCount 始终是真实总数（诚实披露截断）。 */
export interface FileImpactFeature {
  featureId: number;
  featureName: string;
  stableKey: string;
  scenarioCount: number;
  scenarios: Array<{ reference: string; context: string; action: string; outcome: string; source: string; evidence: unknown }>;
}

export interface FileImpactEntry {
  path: string;
  features: FileImpactFeature[];
}

/** 单功能单文件返回的场景上限；溢出靠 scenarioCount 披露，不静默丢弃计数。 */
export const FILE_IMPACT_SCENARIO_CAP = 10;

function evidencePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    if (typeof value === "string") {
      try {
        return evidencePaths(JSON.parse(value));
      } catch {
        return [];
      }
    }
    return [];
  }
  return value
    .map((item) => String((item as { path?: string }).path ?? ""))
    .filter(Boolean);
}

export function buildFeatureConnections(rows: ScenarioEvidenceRow[]): FeatureConnectionEntry[] {
  // file → (featureId → { featureName, references })
  const byFile = new Map<string, Map<number, { featureName: string; references: Set<string> }>>();
  const featureNames = new Map<number, string>();
  for (const row of rows) {
    featureNames.set(row.featureId, row.featureName);
    for (const path of evidencePaths(row.evidence)) {
      let perFeature = byFile.get(path);
      if (!perFeature) {
        perFeature = new Map();
        byFile.set(path, perFeature);
      }
      const entry = perFeature.get(row.featureId) ?? { featureName: row.featureName, references: new Set<string>() };
      entry.references.add(row.reference);
      perFeature.set(row.featureId, entry);
    }
  }
  const pairFiles = new Map<string, Array<{ path: string; sourceScenarios: string[]; targetScenarios: string[] }>>();
  for (const [path, perFeature] of byFile) {
    const featureIds = [...perFeature.keys()].sort((a, b) => a - b);
    for (let i = 0; i < featureIds.length; i += 1) {
      for (let j = i + 1; j < featureIds.length; j += 1) {
        const a = featureIds[i];
        const b = featureIds[j];
        const pairKey = `${a}->${b}`;
        let files = pairFiles.get(pairKey);
        if (!files) {
          files = [];
          pairFiles.set(pairKey, files);
        }
        files.push({ path, sourceScenarios: [...perFeature.get(a)!.references].sort(), targetScenarios: [...perFeature.get(b)!.references].sort() });
      }
    }
  }
  const byFeature = new Map<number, FeatureConnectionEntry>();
  for (const featureId of featureNames.keys()) byFeature.set(featureId, { featureId, featureName: featureNames.get(featureId)!, connections: [] });
  for (const [pairKey, files] of pairFiles) {
    const [a, b] = pairKey.split("->").map(Number);
    files.sort((x, y) => (y.sourceScenarios.length + y.targetScenarios.length) - (x.sourceScenarios.length + x.targetScenarios.length));
    const connection: FeatureConnection = {
      sourceFeatureId: a,
      sourceFeatureName: featureNames.get(a)!,
      targetFeatureId: b,
      targetFeatureName: featureNames.get(b)!,
      sharedFiles: files.slice(0, 5),
    };
    byFeature.get(a)?.connections.push(connection);
    byFeature.get(b)?.connections.push({ ...connection, sourceFeatureId: b, sourceFeatureName: featureNames.get(b)!, targetFeatureId: a, targetFeatureName: featureNames.get(a)! });
  }
  for (const entry of byFeature.values()) {
    entry.connections.sort((x, y) => y.sharedFiles.length - x.sharedFiles.length);
    if (entry.connections.length === 0) byFeature.delete(entry.featureId);
  }
  return [...byFeature.values()].sort((a, b) => a.featureId - b.featureId);
}

/** 读侧：产品全部 active 场景的证据面（与规格页同源）。 */
export async function loadFeatureConnections(
  execute: Execute = defaultExecute,
  productId: number,
  opts: { path?: string; featureStableKey?: string } = {},
): Promise<FeatureConnectionEntry[]> {
  let rows = await loadScenarioEvidenceRows(execute, productId, opts.path ? [opts.path] : undefined);
  // SQL LIKE 只是预过滤（子串会误中 lib/auth.tsx ← lib/auth.ts），建图前按证据路径精确筛一次
  if (opts.path) rows = rows.filter((row) => evidencePaths(row.evidence).includes(opts.path!));
  const entries = buildFeatureConnections(rows);
  if (opts.featureStableKey) {
    const wanted = specFeatureKey(opts.featureStableKey);
    return entries.filter((entry) => specFeatureKey(entry.featureName) === wanted);
  }
  return entries;
}

/** 证据反查：文件 → 以该文件为证据的功能与场景（coding agent 改动前影响面检查）。 */
export async function lookupFilesImpact(execute: Execute = defaultExecute, productId: number, paths: string[]): Promise<FileImpactEntry[]> {
  const wanted = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const rows = await loadScenarioEvidenceRows(execute, productId, wanted);
  return buildFileImpact(rows, wanted);
}

function rowsOf(result: unknown): ScenarioEvidenceRow[] {
  return ((Array.isArray(result) ? result[0] : result) ?? []) as ScenarioEvidenceRow[];
}

/** 共享行加载：产品全部 active 场景证据面；evidencePrefilters 用 LIKE 预过滤缩小集合（精确性由调用方复核）。 */
async function loadScenarioEvidenceRows(execute: Execute, productId: number, evidencePrefilters?: string[]): Promise<ScenarioEvidenceRow[]> {
  const likes = evidencePrefilters?.length ? ` AND (${evidencePrefilters.map(() => "s.evidence LIKE ?").join(" OR ")})` : "";
  const result = await execute(
    `SELECT s.id, s.feature_id AS featureId, f.name AS featureName, s.reference, s.context, s.action, s.outcome, s.source, s.evidence
     FROM scenarios s JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND s.active = 1 AND f.active = 1${likes}
     ORDER BY f.id, s.id`,
    [productId, ...(evidencePrefilters ?? []).map((path) => likePattern(path))],
  ) as unknown;
  return rowsOf(result);
}

/** 文件反查聚合（纯函数）：请求路径保序去重、证据路径精确匹配、每功能场景截前 N 条并披露真实总数。 */
export function buildFileImpact(rows: ScenarioEvidenceRow[], paths: string[]): FileImpactEntry[] {
  const wanted = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
  if (wanted.length === 0) return [];
  const wantedSet = new Set(wanted);
  // path → (featureId → 命中)
  const hits = new Map<string, Map<number, FileImpactFeature>>();
  for (const row of rows) {
    for (const path of evidencePaths(row.evidence)) {
      if (!wantedSet.has(path)) continue;
      let perFeature = hits.get(path);
      if (!perFeature) {
        perFeature = new Map();
        hits.set(path, perFeature);
      }
      const feature = perFeature.get(row.featureId) ?? {
        featureId: row.featureId,
        featureName: row.featureName,
        stableKey: specFeatureKey(row.featureName),
        scenarioCount: 0,
        scenarios: [],
      };
      if (feature.scenarios.length < FILE_IMPACT_SCENARIO_CAP) {
        feature.scenarios.push({ reference: row.reference, context: row.context ?? "", action: row.action ?? "", outcome: row.outcome ?? "", source: row.source ?? "", evidence: row.evidence });
      }
      feature.scenarioCount += 1;
      perFeature.set(row.featureId, feature);
    }
  }
  return wanted
    .filter((path) => hits.has(path))
    .map((path) => ({ path, features: [...hits.get(path)!.values()].sort((a, b) => a.featureId - b.featureId) }));
}
