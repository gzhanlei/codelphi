import { describe, expect, it } from "vitest";
import { planChangesDedupe, type PlannableChangeRow } from "../scripts/dedupe-release-changes";

const row = (id: number, featureName: string, kind: string, description: string): PlannableChangeRow => ({ id, releaseId: 225, featureName, kind, description });

const partialDisclosureVariants = [
  "mergeIntegrity 维度新增 featuresFolded 字段，折叠数大于 0 时该维度记为 partial；deriveMergeIntegrity 入参新增 featuresFolded。",
  "合并完整性维度新增 featuresFolded 计数，大于 0 时该维度记为 partial。",
  "MergeIntegrityDimension 新增 featuresFolded 字段，deriveMergeIntegrity 在 featuresFolded>0 时把合并完整性记为 partial。",
  "合并完整性维度新增 featuresFolded 字段，功能级变体被折叠时该维度记为 partial 并如实披露折叠数量。",
];

describe("planChangesDedupe (BM-11 changes 存量清理规划器)", () => {
  it("keeps the first row and drops wording variants within the same feature+kind", () => {
    const rows = partialDisclosureVariants.map((description, index) => row(index + 1, "分析完整性账本", "changed", description));
    const plans = planChangesDedupe(rows);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ releaseId: 225, featureName: "分析完整性账本", kind: "changed", keepId: 1 });
    expect(plans[0].dropIds).toEqual([2, 3, 4]);
  });

  it("does not cross feature or kind boundaries", () => {
    const rows = [
      row(1, "分析完整性账本", "changed", partialDisclosureVariants[0]),
      row(2, "AI 规格分析与发布变化", "changed", partialDisclosureVariants[1]),
      row(3, "分析完整性账本", "added", partialDisclosureVariants[2]),
    ];
    expect(planChangesDedupe(rows)).toEqual([]);
  });

  it("keeps genuinely different change items of the same feature+kind", () => {
    const rows = [
      row(1, "分析完整性账本", "changed", partialDisclosureVariants[0]),
      row(2, "分析完整性账本", "changed", "mergeChunkResults 的 onStats 回调新增 featuresFolded 计数，mergeStats 初始化与 saveResult 返回值新增 featureFolds 字段。"),
    ];
    expect(planChangesDedupe(rows)).toEqual([]);
  });

  it("is deterministic on unordered input (sorts by id for keeper choice)", () => {
    const rows = [
      row(7, "分析完整性账本", "changed", partialDisclosureVariants[2]),
      row(3, "分析完整性账本", "changed", partialDisclosureVariants[0]),
    ];
    const plans = planChangesDedupe(rows);
    expect(plans[0].keepId).toBe(3);
    expect(plans[0].dropIds).toEqual([7]);
  });
});
