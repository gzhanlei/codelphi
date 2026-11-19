import { compareCodePoints } from "./behavior-inventory/identity";
import type { AnchorScenarioLink } from "./behavior-unit-state";
import { mergeChunkResults, type ExtractionChunk, type MergeResult } from "./extraction-merge";

/**
 * Task 11 · 合并过程传播 originKeys（设计 §5.3 收口层）：
 * mergeBehaviorTaskResults 在 mergeChunkResults 的确定性合并之上，返回
 * AnalysisResult（存活场景带 originKeys 并集）+ 锚点关联（anchor links）+ 合并统计。
 *
 * 关联行只透传不重推导：Task 10 的跨锚点归属（assignment.anchorKey）只是 ordinal
 * 分配场所，本层保留每一条 linkedAnchorKey 展开出的关联行，绝不从 localScenarioKey
 * 反解「归属锚点」而丢掉其余支撑锚点。final_scenario_id 由 Task 12 在最终事务回填。
 */

export interface BehaviorMergedResult {
  /** 合并后的完整规格；存活场景的 originKeys 是全部输入 origin 的并集。 */
  result: MergeResult;
  /** 全部输入 chunk 的锚点关联行：按 (anchorKey, localScenarioKey) 去重并码点序排序。 */
  anchorLinks: AnchorScenarioLink[];
  /** mergeChunkResults 的合并统计（截断/去重/折叠计数），供 Task 13 mergeStats 透传。 */
  stats: { changesTruncated: number; scenariosDeduped: number; featuresFolded: number };
}

export function mergeBehaviorTaskResults(chunks: ExtractionChunk[]): BehaviorMergedResult {
  let stats = { changesTruncated: 0, scenariosDeduped: 0, featuresFolded: 0 };
  const result = mergeChunkResults(chunks, (captured) => {
    stats = captured;
  });
  const links = new Map<string, AnchorScenarioLink>();
  for (const chunk of chunks) {
    for (const link of chunk.anchorLinks ?? []) {
      const id = JSON.stringify([link.anchorKey, link.localScenarioKey]);
      if (!links.has(id)) links.set(id, link);
    }
  }
  const anchorLinks = [...links.values()].sort(
    (a, b) => compareCodePoints(a.anchorKey, b.anchorKey) || compareCodePoints(a.localScenarioKey, b.localScenarioKey),
  );
  return { result, anchorLinks, stats };
}
