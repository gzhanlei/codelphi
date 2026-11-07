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
 * 方案 A 放行门槛（2026-11-07 排查结论，docs/m9-workbench-carry-forward-handoff.md）：
 * ①功能 key 集合强制一致（missing/extra 均为空）；②(reference, category) 集合的
 * 宏平均 Jaccard ≥ 98%。场景文本签名不参与判定——ds-flash 对同代码两次独立提取的
 * 场景分解与措辞高度可变（实测文本级一致率 0%），门槛语义已由产品决策调整为 A。
 * summary 措辞差异同理不参与判定。
 */
export const SHADOW_REFERENCE_GATE = 0.98;

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
