import { describe, expect, it } from "vitest";
import { assertLegacyDedupeApplyDisabled, planChangesDedupe, type PlannableChangeRow } from "../scripts/dedupe-release-changes";

const row = (id: number, featureName: string, kind: string, description: string, userImpact = ""): PlannableChangeRow => ({ id, releaseId: 225, featureName, kind, description, userImpact });

const partialDisclosureVariants = [
  "mergeIntegrity 维度新增 featuresFolded 字段，折叠数大于 0 时该维度记为 partial；deriveMergeIntegrity 入参新增 featuresFolded。",
  "合并完整性维度新增 featuresFolded 计数，大于 0 时该维度记为 partial。",
  "MergeIntegrityDimension 新增 featuresFolded 字段，deriveMergeIntegrity 在 featuresFolded>0 时把合并完整性记为 partial。",
  "合并完整性维度新增 featuresFolded 字段，功能级变体被折叠时该维度记为 partial 并如实披露折叠数量。",
];

describe("planChangesDedupe (BM-11 changes 存量清理规划器)", () => {
  it("refuses destructive fuzzy apply while preserving dry-run diagnostics", () => {
    expect(() => assertLegacyDedupeApplyDisabled(true)).toThrow("--apply 已停用");
    expect(() => assertLegacyDedupeApplyDisabled(false)).not.toThrow();
  });

  it("keeps the first row and drops wording variants within the same feature+kind", () => {
    const rows = partialDisclosureVariants.map((description, index) => row(index + 1, "分析完整性账本", "changed", description));
    const plans = planChangesDedupe(rows);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ releaseId: 225, featureName: "分析完整性账本", kind: "changed", keepId: 1 });
    expect(plans[0].dropIds).toEqual([2, 3, 4]);
  });

  it("kind is not a dedupe boundary (release 227 实证：同一行为标 changed 与 fixed 各一条), but added↔removed never folds", () => {
    const rows = [
      row(1, "功能级变体判定与存量清理", "changed", "身份判定改为名字通道或双信号通道；场景门禁在双信号通道下放宽。", "同一组件被换字命名析出的异名功能不再重复记为新增功能，发布变化清单更干净；同文件但行为不同的功能仍保持独立。"),
      row(2, "功能级变体判定与存量清理", "fixed", "身份判定改为名字通道或双信号通道；双信号通道下场景门禁放宽为至少 1 对配对。", "同一组件被换名析出的多个功能不再在发布变化中重复记为 added，规格功能清单不再出现重复条目。"),
      row(3, "AI 规格分析与发布变化", "changed", partialDisclosureVariants[1]),
    ];
    const plans = planChangesDedupe(rows);
    expect(plans).toHaveLength(1);
    expect(plans[0].keepId).toBe(1);
    expect(plans[0].dropIds).toEqual([2]);
    // added↔removed 语义相反：即使描述近同文也不得互折
    const conflict = planChangesDedupe([
      row(4, "登录功能", "added", "新增邮箱密码登录入口"),
      row(5, "登录功能", "removed", "新增邮箱密码登录入口"),
    ]);
    expect(conflict).toEqual([]);
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
