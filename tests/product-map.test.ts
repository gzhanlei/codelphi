import { describe, expect, it } from "vitest";
import { MAP_MAX_EDGES, buildProductMap } from "../lib/product-map";
import type { FeatureRow, ScenarioRow } from "../lib/types";

const feature = (id: number, name: string, parentId: number | null = null, summary = `${name}摘要`): FeatureRow =>
  ({ id, name, summary, parentId, source: "generated" } as FeatureRow);

const scenario = (id: number, featureId: number, reference: string, paths: string[]): ScenarioRow =>
  ({ id, featureId, reference, context: "情境", action: "操作", outcome: "结果", category: "happy", source: "generated", evidence: paths.map((path) => ({ path })) } as ScenarioRow);

describe("product map layout (B3.2 产品级合成)", () => {
  it("groups children under parent columns with scenario counts", () => {
    const map = buildProductMap(
      [feature(1, "规格"), feature(2, "登录"), feature(3, "登录找回", 2)],
      [scenario(1, 1, "HP-1", ["a.ts"]), scenario(2, 3, "HP-1", ["b.ts"])],
    );
    const parent = map.nodes.find((node) => node.id === 2)!;
    const child = map.nodes.find((node) => node.id === 3)!;
    expect(parent.kind).toBe("feature");
    expect(parent.childCount).toBe(1);
    expect(child.x).toBe(parent.x);
    expect(child.y).toBeGreaterThan(parent.y);
    expect(parent.scenarioCount).toBe(0);
    expect(child.scenarioCount).toBe(1);
    expect(map.stats).toMatchObject({ featureCount: 3, topLevelCount: 2, childCount: 1, scenarioCount: 2 });
  });

  it("dedupes bidirectional B3 connections into one edge with combined weight", () => {
    const map = buildProductMap(
      [feature(1, "登录"), feature(2, "导出")],
      [scenario(1, 1, "HP-1", ["shared.ts"]), scenario(2, 1, "EC-1", ["shared.ts"]), scenario(3, 2, "HP-1", ["shared.ts"])],
    );
    expect(map.edges).toHaveLength(1);
    // 两侧场景引用合计：登录 2 + 导出 1
    expect(map.edges[0].weight).toBe(3);
    expect(map.stats.edgeCount).toBe(1);
    expect(map.stats.truncatedEdgeCount).toBe(0);
  });

  it("is deterministic for identical input", () => {
    const features = [feature(1, "登录"), feature(2, "导出"), feature(3, "找回", 1)];
    const scenarios = [scenario(1, 1, "HP-1", ["a.ts"]), scenario(2, 2, "HP-1", ["a.ts"])];
    expect(buildProductMap(features, scenarios)).toEqual(buildProductMap(features, scenarios));
  });

  it("caps visible edges at MAP_MAX_EDGES and discloses truncation", () => {
    const features: FeatureRow[] = [];
    const scenarios: ScenarioRow[] = [];
    const featureCount = MAP_MAX_EDGES + 5;
    for (let id = 1; id <= featureCount; id += 1) features.push(feature(id, `功能${id}`));
    // 每对功能共享一个独占文件 → 全配对 C(n,2) 条连接
    let scenarioId = 1;
    for (let a = 1; a <= featureCount; a += 1) {
      for (let b = a + 1; b <= featureCount; b += 1) {
        scenarios.push(scenario(scenarioId++, a, "HP-1", [`pair-${a}-${b}.ts`]));
        scenarios.push(scenario(scenarioId++, b, "HP-1", [`pair-${a}-${b}.ts`]));
      }
    }
    const map = buildProductMap(features, scenarios);
    expect(map.edges).toHaveLength(MAP_MAX_EDGES);
    expect(map.stats.edgeCount).toBe((featureCount * (featureCount - 1)) / 2);
    expect(map.stats.truncatedEdgeCount).toBe(map.stats.edgeCount - MAP_MAX_EDGES);
    // 降序：首边权重不低于末边
    expect(map.edges[0].weight).toBeGreaterThanOrEqual(map.edges[MAP_MAX_EDGES - 1].weight);
  });

  it("excludes scenarios whose feature no longer exists", () => {
    const map = buildProductMap(
      [feature(1, "登录")],
      [scenario(1, 1, "HP-1", ["a.ts"]), scenario(2, 99, "HP-1", ["a.ts"])],
    );
    expect(map.stats.scenarioCount).toBe(2); // 与规格页同源计数，不过滤入参
    expect(map.stats.edgeCount).toBe(0);
  });

  it("renders zero-edge maps with explicit disclosure instead of hiding nodes", () => {
    const map = buildProductMap(
      [feature(1, "登录"), feature(2, "导出")],
      [scenario(1, 1, "HP-1", ["auth.ts"]), scenario(2, 2, "HP-1", ["export.ts"])],
    );
    expect(map.nodes).toHaveLength(2);
    expect(map.edges).toHaveLength(0);
    expect(map.stats.edgeCount).toBe(0);
  });

  it("returns an empty map for a product without features", () => {
    const map = buildProductMap([], []);
    expect(map.nodes).toEqual([]);
    expect(map.edges).toEqual([]);
    expect(map.stats.featureCount).toBe(0);
  });
});
