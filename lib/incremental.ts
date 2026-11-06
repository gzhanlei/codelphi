export const MAX_AFFECTED_RATIO = 0.6;
export const MAX_DIFF_FILES = 200;

export interface IncrementalDecision {
  mode: "full" | "incremental";
  hasPreviousSpec: boolean;
  affectedCount: number;
  previousFeatureCount: number;
  diffFileCount: number;
}

/**
 * 增量模式放行判定（纯函数）。任一保守条件不满足即回退全量：
 * 无上一版规格、受影响集为空（可能是索引未覆盖的新功能）、
 * 受影响占比超阈值、diff 过宽，或本来就是全量模式。
 */
export function resolveAnalysisMode(decision: IncrementalDecision): "full" | "incremental" {
  if (decision.mode !== "incremental") return "full";
  if (!decision.hasPreviousSpec) return "full";
  if (decision.affectedCount === 0) return "full";
  if (decision.diffFileCount > MAX_DIFF_FILES) return "full";
  if (decision.previousFeatureCount > 0 && decision.affectedCount / decision.previousFeatureCount > MAX_AFFECTED_RATIO) return "full";
  return "incremental";
}
