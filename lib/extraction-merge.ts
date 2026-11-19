import type { AnalysisResult } from "./ai";
import type { AnchorScenarioLink } from "./behavior-unit-state";
import { featureScenarioPairMatch, featureVariantSimilar, normalizeSpecText, scenarioBehaviorEqual, scenarioVariantSimilar, specFeatureKey, type SpecFeature } from "./spec-diff";

/**
 * 多趟提取的确定性合并层：把 N 个分区窗口各自的 AnalysisResult 合并为一个完整规格。
 * 只做规则合并（无 AI 通道）：功能按 stable key 分组、场景按行为等价去重、引用冲突
 * 重编号、reviewed 审计候选精确去重截断。每趟结果在提取层已过 zod 与 assertEvidence（分区局部口径），
 * 合并对象有意绕过 zod 的 ≤50 功能/≤40 场景上限（DB 无对应上限）。
 *
 * Task 11 · originKeys 传播：合并输入场景可携带 Task 10 的局部场景身份（originKeys）。
 * 去重（BM-5 等价 / BM-6 变体）、BM-11 跨 group 功能折叠、引用冲突重编号都只决定
 * 「哪条文案存活」，originKeys 一律求并集挂到存活场景上——身份与呈现分离：
 * origin 绝不进入 scenarioBehaviorEqual / scenarioVariantSimilar / featureVariantSimilar
 * 判定，也不进入 prompt 与展示文本。无 origin 的旧分区结果输出逐字段保持旧行为。
 */

type BaseScenario = AnalysisResult["features"][number]["scenarios"][number];
type BaseFeature = AnalysisResult["features"][number];

/** 合并层输入/输出场景：提取结果场景 + 可选的 Task 10 局部场景身份并集。 */
export type MergeScenario = BaseScenario & { originKeys?: string[] };
export type MergeFeature = Omit<BaseFeature, "scenarios"> & { scenarios: MergeScenario[] };
export type MergeResult = Omit<AnalysisResult, "features"> & { features: MergeFeature[] };

export interface ExtractionChunk {
  result: MergeResult;
  /** Task 11 · 可选：Task 10 产出的锚点↔局部场景关联行（含每个 linkedAnchorKey，
   *  不只是 ordinal 归属锚点）。旧分区结果没有来源信息时缺省。 */
  anchorLinks?: AnchorScenarioLink[];
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

/** Task 11：去重/折叠保留先到者文案，行为来源求并集（先到者原有 origin 在前，保持确定性）。
 *  只读 originKeys，不改写行为字段；incoming 无 origin 时 kept 原样（旧分区语义不变）。 */
function unionOriginKeys(kept: MergeScenario, incoming: MergeScenario) {
  if (!incoming.originKeys || incoming.originKeys.length === 0) return;
  const union = kept.originKeys ? [...kept.originKeys] : [];
  for (const key of incoming.originKeys) if (!union.includes(key)) union.push(key);
  kept.originKeys = union;
}

export function mergeChunkResults(chunks: ExtractionChunk[], onStats?: (stats: { changesTruncated: number; scenariosDeduped: number; featuresFolded: number }) => void): MergeResult {
  if (chunks.length === 0) throw new Error("mergeChunkResults requires at least one chunk");
  const first = chunks[0].result;

  interface FeatureGroup {
    name: string;
    summary: string;
    summaryScenarioCount: number;
    scenarios: MergeScenario[];
    references: string[];
  }
  const groups = new Map<string, FeatureGroup>();
  let scenariosDeduped = 0;
  // 场景入组（去重 + 引用冲突重编号）：主分组循环与跨 group 变体折叠共用。
  // 去重判定函数由调用方选择——主分组走 BM-5/BM-6 严通道（HP-3 红线口径不变），
  // BM-11 折叠通道内走 featureScenarioPairMatch（被大段改写的同行为场景也须收口，
  // 否则折叠后的 keeper 内部还留着用户看到的那三条重复文案）。
  const addScenarioToGroup = (group: FeatureGroup, scenario: MergeScenario, isDuplicate: (existing: MergeScenario, incoming: MergeScenario) => boolean) => {
    const duplicate = group.scenarios.find((existing) => isDuplicate(existing, scenario));
    if (duplicate) {
      scenariosDeduped += 1;
      // Task 11：文案保留先到者，但每个行为来源（originKeys）都必须存活。
      unionOriginKeys(duplicate, scenario);
      return;
    }
    // 引用冲突：同引用已存在但行为不同 → 前缀重编号（spec_scenarios 唯一键 (feature, reference)）
    const reference = group.references.includes(scenario.reference) ? nextReference(group.references, scenario.reference) : scenario.reference;
    group.references.push(reference);
    group.scenarios.push({ ...scenario, reference } as typeof scenario & { variantOf?: string });
  };
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
        addScenarioToGroup(
          group,
          scenario,
          // 行为等价去重（BM-5）：情境/操作/结果同义即同一行为（category 只是呈现标签）。
          // 守护教训：骨架词判定实证不可用（fixture 实证误合真差异："跳转 dashboard" vs
          // "锁定账户"骨架共享但行为不同），近似通道必须走严格阈值（见 spec-diff 变体三重守护）。
          // BM-6 变体通道：单分区输出的措辞变体（run 211/212 实证：同行为从不同角色
          // 重复建条，EC-5/EC-6 同义并存）不经过跨趟合并也会落库——近似折叠在此收口，
          // 与跨版本 spec-diff 的 variant 折叠共用同一判定（宁漏勿错合）。
          (existing, incoming) => scenarioBehaviorEqual(existing, incoming) || scenarioVariantSimilar(existing, incoming),
        );
      }
    }
  }

  // BM-11 功能级变体折叠（run 内跨 group）：不同分区对同一组件用不同名字建组
  // （release 220 实证：admin-pay-orders.tsx 一处组件析出「管理端支付台账/管理端支付
  // 订单台账/超管支付台账面板/超管支付订单台账」×4 全标新增）。分组只按精确 key，
  // 这里做跨名字收口：featureVariantSimilar 三重门禁（名/身/场景）全过才折，keeper
  // 取先出现名（确定性）。partitionNotice 向模型承诺「合并层统一去重与归并」，此处兑现。
  // O(n²) 名称门禁前置：绝大多数对在名字比较即被拒，场景配对只发生在极少数候选对上。
  const asFeature = (group: FeatureGroup): SpecFeature => ({ name: group.name, summary: group.summary, scenarios: group.scenarios });
  const kept: FeatureGroup[] = [];
  let featuresFolded = 0;
  for (const group of groups.values()) {
    const target = kept.find((candidate) => featureVariantSimilar(asFeature(candidate), asFeature(group)));
    if (!target) {
      kept.push(group);
      continue;
    }
    for (const scenario of group.scenarios) {
      addScenarioToGroup(target, scenario, featureScenarioPairMatch);
    }
    featuresFolded += 1;
  }

  const features = kept
    .map((group) => ({ name: group.name, summary: group.summary, scenarios: group.scenarios }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const changes: AnalysisResult["changes"] = [];
  const seenChanges = new Set<string>();
  // 提取趟只保留内部实现的 reviewed 审计候选；最终用户变化由合并后的 spec_changes 统一投影。
  // 这里只做精确去重，不用自然语言相似度推断行为身份。
  for (const { result } of chunks) {
    for (const change of result.changes) {
      if (change.kind !== "reviewed") continue;
      const descriptionKey = `${specFeatureKey(change.featureName)}:${normalizeSpecText(change.description)}:${JSON.stringify(change.evidence)}`;
      if (seenChanges.has(descriptionKey)) continue;
      seenChanges.add(descriptionKey);
      changes.push(change);
    }
  }

  return {
    product: first.product,
    release: first.release,
    // reviewed 审计候选截断到 schema 上限：分区越多越容易超；精确去重后保留前 150 条。
    // 截断必须日志可查（W0-4）：不静默丢弃，runId 级排查靠这条日志对账。
    changes: (() => {
      if (changes.length <= 150) {
        onStats?.({ changesTruncated: 0, scenariosDeduped, featuresFolded });
        return changes;
      }
      console.log("[extraction-merge] changes truncated", { before: changes.length, after: 150, dropped: changes.length - 150 });
      onStats?.({ changesTruncated: changes.length - 150, scenariosDeduped, featuresFolded });
      return changes.slice(0, 150);
    })(),
    features,
  };
}
