import type { AnalysisResult } from "./ai";
import { normalizeSpecText, scenarioBehaviorEqual, scenarioVariantSimilar, specFeatureKey } from "./spec-diff";

/**
 * 多趟提取的确定性合并层：把 N 个分区窗口各自的 AnalysisResult 合并为一个完整规格。
 * 只做规则合并（无 AI 通道）：功能按 stable key 分组、场景按行为等价去重、引用冲突
 * 重编号、changes 去重截断。每趟结果在提取层已过 zod 与 assertEvidence（分区局部口径），
 * 合并对象有意绕过 zod 的 ≤50 功能/≤40 场景上限（DB 无对应上限）。
 */

export interface ExtractionChunk {
  result: AnalysisResult;
}

/** 前缀重编号：取同前缀现有最大序号 +1（HP-9 → HP-10）。分区合并与坍缩回填共用。 */
export function nextReference(used: string[], reference: string) {
  const match = reference.match(/^([A-Za-z]+)-(\d+)$/);
  if (!match) return reference;
  const [, prefix] = match;
  let max = 0;
  for (const item of used) {
    const itemMatch = item.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (itemMatch) max = Math.max(max, Number(itemMatch[1]));
  }
  return `${prefix}-${max + 1}`;
}

export function mergeChunkResults(chunks: ExtractionChunk[], onStats?: (stats: { changesTruncated: number; scenariosDeduped: number }) => void): AnalysisResult {
  if (chunks.length === 0) throw new Error("mergeChunkResults requires at least one chunk");
  const first = chunks[0].result;

  interface FeatureGroup {
    name: string;
    summary: string;
    summaryScenarioCount: number;
    scenarios: AnalysisResult["features"][number]["scenarios"];
    references: string[];
  }
  const groups = new Map<string, FeatureGroup>();
  let scenariosDeduped = 0;
  for (const { result } of chunks) {
    for (const feature of result.features) {
      const key = specFeatureKey(feature.name);
      let group = groups.get(key);
      if (!group) {
        group = { name: feature.name, summary: feature.summary, summaryScenarioCount: feature.scenarios.length, scenarios: [], references: [] };
        groups.set(key, group);
      }
      // 摘要归属：场景数最多的趟胜出（并列取先）
      if (feature.scenarios.length > group.summaryScenarioCount) {
        group.summary = feature.summary;
        group.summaryScenarioCount = feature.scenarios.length;
      }
      for (const scenario of feature.scenarios) {
        // 行为等价去重（BM-5）：情境/操作/结果同义即同一行为（category 只是呈现标签）。
        // 守护教训：骨架词判定实证不可用（fixture 实证误合真差异："跳转 dashboard" vs
        // "锁定账户"骨架共享但行为不同），近似通道必须走严格阈值（见 spec-diff 变体三重守护）。
        // BM-6 变体通道：单分区输出的措辞变体（run 211/212 实证：同行为从不同角色
        // 重复建条，EC-5/EC-6 同义并存）不经过跨趟合并也会落库——近似折叠在此收口，
        // 与跨版本 spec-diff 的 variant 折叠共用同一判定（宁漏勿错合）。
        if (group.scenarios.some((existing) => scenarioBehaviorEqual(existing, scenario) || scenarioVariantSimilar(existing, scenario))) {
          scenariosDeduped += 1;
          continue;
        }
        // 引用冲突：同引用已存在但行为不同 → 前缀重编号（spec_scenarios 唯一键 (feature, reference)）
        const reference = group.references.includes(scenario.reference) ? nextReference(group.references, scenario.reference) : scenario.reference;
        group.references.push(reference);
        group.scenarios.push({ ...scenario, reference } as typeof scenario & { variantOf?: string });
      }
    }
  }

  const features = [...groups.values()]
    .map((group) => ({ name: group.name, summary: group.summary, scenarios: group.scenarios }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const changes: AnalysisResult["changes"] = [];
  const seenChanges = new Set<string>();
  for (const { result } of chunks) {
    for (const change of result.changes) {
      const dedupeKey = `${specFeatureKey(change.featureName)}:${change.kind}:${normalizeSpecText(change.description)}`;
      if (seenChanges.has(dedupeKey)) continue;
      seenChanges.add(dedupeKey);
      changes.push(change);
    }
  }

  return {
    product: first.product,
    release: first.release,
    // changes 截断到 schema 上限：分区越多越容易超；发布页 changelog 取去重后的前 150 条。
    // 截断必须日志可查（W0-4）：不静默丢弃，runId 级排查靠这条日志对账。
    changes: (() => {
      if (changes.length <= 150) {
        onStats?.({ changesTruncated: 0, scenariosDeduped });
        return changes;
      }
      console.log("[extraction-merge] changes truncated", { before: changes.length, after: 150, dropped: changes.length - 150 });
      onStats?.({ changesTruncated: changes.length - 150, scenariosDeduped });
      return changes.slice(0, 150);
    })(),
    features,
  };
}
