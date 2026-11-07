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
 * 对比对象是 carry-forward 合并后的增量规格（调用方传入，即 insertSpecVersion 的
 * 三分合并产物）与全量 AI 输出——增量 AI 只提取受影响功能，直接比较其原始输出
 * 会恒等失败。合并与全量路径的 manual 叠加语义相同，因此合并后特性集与场景行为
 * 签名一致即等价于最终 spec 一致。
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
