import { defaultExecute, type Execute } from "./db";

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
}

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
export async function loadFeatureConnections(execute: Execute = defaultExecute, productId: number): Promise<FeatureConnectionEntry[]> {
  const result = await execute(
    `SELECT s.id, s.feature_id AS featureId, f.name AS featureName, s.reference, s.evidence
     FROM scenarios s JOIN features f ON f.id = s.feature_id
     WHERE f.product_id = ? AND s.active = 1 AND f.active = 1
     ORDER BY f.id, s.id`,
    [productId],
  ) as unknown;
  const rows = (Array.isArray(result) ? result[0] : result) as ScenarioEvidenceRow[];
  return buildFeatureConnections(rows ?? []);
}
