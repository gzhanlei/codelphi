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
  /** (reference, category) 集合的宏平均 Jaccard，0..1；方案 A 的一致率指标。 */
  referenceConsistency: number;
  /** 低于门槛的功能 key（诊断用）。 */
  inconsistentFeatures: string[];
}

/**
 * 方案 A 放行门槛（2026-11-07 排查 + 生产决策）：
 * ①功能 key 集合强制一致（missing/extra 均为空，零容忍）；②(reference, category)
 * 集合的宏平均 Jaccard ≥ 0.70。场景文本签名不参与判定。
 * 0.70 的依据：全量 vs 全量（近同代码）的噪声底实测 0.80——ds-flash 对同代码两次
 * 独立提取的 (ref,cat) 集合 Jaccard 只有约 0.80，98% 在数学上不可达；0.70 位于
 * 噪声底之下、结构性故障态（约 0.33-0.5）之上，可检出增量链路的真回归。
 * 98% 的原始语义转移到「功能 key 集合一致率」（当前 100%）。
 */
export const SHADOW_REFERENCE_GATE = 0.7;

type ReferenceSignature = string;

function scenarioSignatures(feature: ShadowAnalysis["features"][number]): Set<ReferenceSignature> {
  return new Set(feature.scenarios.map((scenario) => `${scenario.reference}|${scenario.category}`));
}

export function compareIncrementalShadow(incremental: ShadowAnalysis, full: ShadowAnalysis): ShadowReport {
  const incrementalKeys = new Map(incremental.features.map((feature) => [specFeatureKey(feature.name), feature]));
  const fullKeys = new Map(full.features.map((feature) => [specFeatureKey(feature.name), feature]));
  const missingKeys = [...fullKeys.keys()].filter((key) => !incrementalKeys.has(key));
  const extraKeys = [...incrementalKeys.keys()].filter((key) => !fullKeys.has(key));

  const inconsistentFeatures: string[] = [];
  let jaccardSum = 0;
  const allKeys = [...new Set([...incrementalKeys.keys(), ...fullKeys.keys()])];
  for (const key of allKeys) {
    // 功能本身缺失（missing/extra）记 0：存在性是一致性的前提。
    if (!incrementalKeys.has(key) || !fullKeys.has(key)) {
      jaccardSum += 0;
      inconsistentFeatures.push(key);
      continue;
    }
    const incrementalSignatures = scenarioSignatures(incrementalKeys.get(key)!);
    const fullSignatures = scenarioSignatures(fullKeys.get(key)!);
    const intersection = [...incrementalSignatures].filter((s) => fullSignatures.has(s)).length;
    const union = incrementalSignatures.size + fullSignatures.size - intersection;
    const ratio = union === 0 ? 1 : intersection / union;
    jaccardSum += ratio;
    if (ratio < 1) inconsistentFeatures.push(key);
  }
  const referenceConsistency = allKeys.length === 0 ? 1 : jaccardSum / allKeys.length;

  return {
    consistent: missingKeys.length === 0 && extraKeys.length === 0 && referenceConsistency >= SHADOW_REFERENCE_GATE,
    missingKeys,
    extraKeys,
    referenceConsistency,
    inconsistentFeatures: inconsistentFeatures.sort(),
  };
}
