import { describe, expect, it } from "vitest";
import { SALESBUDDY_DOMAINS, SALESBUDDY_UNGROUPED_IDS, planSalesBuddyBusinessDomainMigration, type MigrationFeatureRow } from "../scripts/salesbuddy-business-domain-migration";

/** 按计划清单构造 45 个 active 功能（22 个进入分组 + 23 个不分组）。 */
function fullFeatureSet(): MigrationFeatureRow[] {
  const mapped = SALESBUDDY_DOMAINS.flatMap((domain) => domain.featureIds.map((id, index) => ({
    id, name: `功能${id}`, summary: "", parentId: null, source: "generated", active: 1,
    verifiedAt: index % 2 === 0 ? new Date("2026-11-01") : null,
    verifiedBy: index % 2 === 0 ? "维护者" : null,
    lastEditedAt: index % 3 === 0 ? new Date("2026-11-02") : null,
    lastEditedBy: index % 3 === 0 ? "编辑者" : null,
  })));
  const ungrouped = SALESBUDDY_UNGROUPED_IDS.map((id) => ({ id, name: `技术功能${id}`, summary: "", parentId: null, source: "generated", active: 1, verifiedAt: null, verifiedBy: null, lastEditedAt: null, lastEditedBy: null }));
  return [...mapped, ...ungrouped];
}

describe("salesbuddy business domain migration plan (Task 3)", () => {
  it("plans exactly 6 parents, 22 moves and 23 untouched ungrouped features", () => {
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet());
    expect(plan.errors).toEqual([]);
    expect(plan.parents).toHaveLength(6);
    expect(plan.moves).toHaveLength(22);
    expect(plan.ungrouped).toHaveLength(23);
    expect(plan.parents.map((parent) => parent.name)).toEqual(["客户沟通", "客户认知", "商机管理", "承诺管理", "销售执行", "团队管理"]);
  });

  it("records each child's original parent_id, source, verification and edit attribution for rollback", () => {
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet());
    const move71 = plan.moves.find((move) => move.featureId === 71);
    expect(move71).toMatchObject({ featureId: 71, targetDomainKey: "communication", fromParentId: null, source: "generated" });
    // 15118 是 communication 域内第一个 ID（fixture 中有核实与编辑归因）
    expect(plan.snapshot[15118]).toMatchObject({ parentId: null, source: "generated", verifiedBy: "维护者", lastEditedBy: "编辑者" });
  });

  it("aborts on unknown feature IDs without planning any move", () => {
    const missing = fullFeatureSet().filter((feature) => feature.id !== 71);
    const plan = planSalesBuddyBusinessDomainMigration(missing);
    expect(plan.errors.join("\n")).toContain("71");
    expect(plan.moves).toHaveLength(0);
    expect(plan.parents).toHaveLength(0);
  });

  it("aborts when a child already has a parent_id", () => {
    const drifted = fullFeatureSet().map((feature) => (feature.id === 71 ? { ...feature, parentId: 999 } : feature));
    const plan = planSalesBuddyBusinessDomainMigration(drifted);
    expect(plan.errors.join("\n")).toContain("已有父级");
    expect(plan.moves).toHaveLength(0);
  });

  it("aborts when the same feature is targeted by two domains", () => {
    const conflicting = [
      { key: "a", name: "域A", summary: "", featureIds: [71, 72] },
      { key: "b", name: "域B", summary: "", featureIds: [71] },
    ];
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet(), conflicting);
    expect(plan.errors.join("\n")).toContain("71");
    expect(plan.moves).toHaveLength(0);
  });

  it("aborts when the ungrouped list references an unknown feature", () => {
    const plan = planSalesBuddyBusinessDomainMigration(fullFeatureSet(), SALESBUDDY_DOMAINS, [...SALESBUDDY_UNGROUPED_IDS, 424242]);
    expect(plan.errors.join("\n")).toContain("424242");
    expect(plan.moves).toHaveLength(0);
  });
});
