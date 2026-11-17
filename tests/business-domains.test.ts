import { describe, expect, it } from "vitest";
import { buildBusinessDomainCards, countNewUngroupedFeatures } from "../lib/business-domains";
import type { FeatureRow, ScenarioRow } from "../lib/types";

const feature = (id: number, name: string, parentId: number | null = null, extra: Partial<FeatureRow> = {}): FeatureRow =>
  ({ id, name, summary: `${name}概述`, parentId, source: "manual" as const, ...extra });
const scenario = (id: number, featureId: number): ScenarioRow =>
  ({ id, featureId, reference: `HP-${id}`, context: "情境", action: "操作", outcome: "结果", category: "happy" as const, source: "generated" as const, evidence: [] });

// 客户认知（父）自身 2 场景 + 子级 71/72 各 2 场景 = 6；客户沟通（父）无自身场景 + 子级 15118/15138 共 3 场景。
const features: FeatureRow[] = [
  feature(10, "客户认知", null, { displayName: "客户认知视图名" }),
  feature(20, "客户沟通"),
  feature(71, "多源沟通录入与录音", 20),
  feature(72, "转写与 AI 复盘", 10),
  feature(15118, "Agent 邮箱与微信记录入库", 20),
  feature(15138, "录音地点反查", 10),
  feature(30, "未分组技术功能"),
];
const scenarios: ScenarioRow[] = [
  scenario(1, 10), scenario(2, 10),
  scenario(3, 71), scenario(4, 71),
  scenario(5, 72), scenario(6, 72),
  scenario(7, 15118), scenario(8, 15138), scenario(9, 15138),
  scenario(10, 30),
];

describe("business domain projection (Task 1)", () => {
  it("aggregates parent's own scenarios plus direct children's scenarios, counting each once", () => {
    const cards = buildBusinessDomainCards(features, scenarios, "/products/o/p");
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => card.canonicalName)).toEqual(["客户认知", "客户沟通"]);
    expect(cards[0]).toMatchObject({ id: 10, canonicalName: "客户认知", name: "客户认知视图名", source: "manual", scenarioCount: 6 });
    expect(cards[1]).toMatchObject({ id: 20, canonicalName: "客户沟通", name: "客户沟通", scenarioCount: 3 });
  });

  it("does not recurse into a third level", () => {
    // 15138 自己成了父级：它的子级场景不计入顶级「客户认知」
    const deeper = [...features, feature(99, "深层子功能", 15138)];
    const deeperScenarios = [...scenarios, scenario(11, 99)];
    const cards = buildBusinessDomainCards(deeper, deeperScenarios, "/products/o/p");
    expect(cards.find((card) => card.id === 10)?.scenarioCount).toBe(6);
    expect(cards.find((card) => card.id === 15138)?.scenarioCount).toBe(3);
  });

  it("sorts by scenario count desc then canonicalName", () => {
    const tied = [
      feature(40, "乙域"),
      feature(41, "甲域"),
      feature(42, "子功能", 40),
      feature(43, "子功能二", 41),
    ];
    const tiedScenarios = [scenario(1, 42), scenario(2, 43)];
    const cards = buildBusinessDomainCards(tied, tiedScenarios, "/products/o/p");
    expect(cards.map((card) => card.canonicalName)).toEqual(["乙域", "甲域"]);
  });

  it("returns an empty array when no parent has children (ungrouped products keep the flat fallback)", () => {
    const flat = [feature(1, "甲"), feature(2, "乙")];
    expect(buildBusinessDomainCards(flat, scenarios, "/products/o/p")).toEqual([]);
    expect(buildBusinessDomainCards([], [], "/products/o/p")).toEqual([]);
  });

  it("keeps a parent whose children carry no scenarios visible with zero count", () => {
    // 子级无场景但父级自身有场景：仍是合法业务卡片（0+自身）
    const sparse = [feature(50, "空子级域"), feature(51, "空子级", 50)];
    const cards = buildBusinessDomainCards(sparse, [scenario(1, 50)], "/products/o/p");
    expect(cards).toHaveLength(1);
    expect(cards[0].scenarioCount).toBe(1);
  });

  it("builds href from productBase and the existing featureHref", () => {
    const cards = buildBusinessDomainCards(features, scenarios, "/products/o/p");
    expect(cards[0].href).toBe("/products/o/p?view=spec&feature=10");
  });
});

// ── 主动提示（2026-11-17）：push 分析新增的平铺功能未归入业务域 ──

describe("countNewUngroupedFeatures", () => {
  const ts = (day: string) => new Date(`2026-11-${day}`);
  const row = (id: number, name: string, parentId: number | null, createdAt?: Date): FeatureRow =>
    ({ id, name, summary: "", parentId, source: "manual" as const, createdAt });

  it("returns null when the product has no domain grouping (flat is the default, no hint)", () => {
    expect(countNewUngroupedFeatures([row(1, "甲", null), row(2, "乙", null)])).toBeNull();
    expect(countNewUngroupedFeatures([])).toBeNull();
  });

  it("counts flat features created after the latest domain parent as new-and-ungrouped", () => {
    // 父节点（域）11-10 建立；故意不分组的旧功能 11-01；push 新增 11-15 两个
    const features = [
      row(10, "客户认知", null, ts("10")),
      row(11, "客户沟通", null, ts("10")),
      row(12, "子功能", 10, ts("01")),
      row(30, "故意不分组的运维功能", null, ts("01")),
      row(40, "push 新增功能A", null, ts("15")),
      row(41, "push 新增功能B", null, ts("16")),
    ];
    expect(countNewUngroupedFeatures(features)).toBe(2);
  });

  it("returns 0 when everything recent is grouped (no false alarm on deliberately ungrouped features)", () => {
    const features = [
      row(10, "客户认知", null, ts("10")),
      row(12, "子功能", 10, ts("01")),
      row(30, "故意不分组的运维功能", null, ts("01")),
    ];
    expect(countNewUngroupedFeatures(features)).toBe(0);
  });

  it("returns null when parents carry no timestamps (cannot judge, stay silent)", () => {
    const features = [row(10, "客户认知", null), row(12, "子功能", 10), row(40, "新增", null, ts("15"))];
    expect(countNewUngroupedFeatures(features)).toBeNull();
  });
});
