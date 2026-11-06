import { specFeatureKey } from "./spec-diff";

export interface ShadowAnalysis {
  features: Array<{
    name: string;
    summary?: string;
    scenarios: Array<{ reference: string; context: string; action: string; outcome: string; category: string }>;
  }>;
  changes: unknown[];
}

export interface ShadowReport {
  consistent: boolean;
  missingKeys: string[];
  extraKeys: string[];
  scenarioDiffs: string[];
}

function scenarioSignatures(feature: ShadowAnalysis["features"][number]) {
  return new Set(feature.scenarios.map((scenario) => `${scenario.reference}|${scenario.context}|${scenario.action}|${scenario.outcome}|${scenario.category}`));
}

/**
 * M9 影子对比：增量与全量两次 AI 提取的一致性判定。
 * 对比对象是 AI 输出本身——manual 叠加与 carry-forward 在两条路径上语义相同，
 * 因此 AI 特性集与场景行为签名一致即等价于最终 spec 一致。
 * summary 措辞差异刻意不参与判定（B 已约束命名连续，措辞漂移不构成行为差异）。
 */
export function compareIncrementalShadow(incremental: ShadowAnalysis, full: ShadowAnalysis): ShadowReport {
  const incrementalKeys = new Map(incremental.features.map((feature) => [specFeatureKey(feature.name), feature]));
  const fullKeys = new Map(full.features.map((feature) => [specFeatureKey(feature.name), feature]));
  const missingKeys = [...fullKeys.keys()].filter((key) => !incrementalKeys.has(key));
  const extraKeys = [...incrementalKeys.keys()].filter((key) => !fullKeys.has(key));
  const scenarioDiffs = new Set<string>();
  for (const [key, incrementalFeature] of incrementalKeys) {
    const fullFeature = fullKeys.get(key);
    if (!fullFeature) continue;
    const incrementalSignatures = scenarioSignatures(incrementalFeature);
    const fullSignatures = scenarioSignatures(fullFeature);
    for (const signature of fullSignatures) {
      if (!incrementalSignatures.has(signature)) scenarioDiffs.add(`${key}:${signature.split("|")[0]}`);
    }
    for (const signature of incrementalSignatures) {
      if (!fullSignatures.has(signature)) scenarioDiffs.add(`${key}:${signature.split("|")[0]}`);
    }
  }
  return { consistent: missingKeys.length === 0 && extraKeys.length === 0 && scenarioDiffs.size === 0, missingKeys, extraKeys, scenarioDiffs: [...scenarioDiffs] };
}
