import { describe, expect, it } from "vitest";
import { buildFeatureFlow } from "../lib/feature-flow";

const stepped = [
  { reference: "HP-1", context: "Visitor", action: "Connect a repository", outcome: "Repository linked", category: "happy" as const, step: 1, evidence: [] },
  { reference: "HP-2", context: "Visitor", action: "Trigger first analysis", outcome: "Spec generated", category: "happy" as const, step: 2, evidence: [] },
  { reference: "EC-1", context: "Visitor", action: "Repository over size limit", outcome: "Warning with limit request", category: "edge" as const, step: 1, evidence: [] },
];

describe("feature flow automatic layout", () => {
  it("lays out a stepped chain vertically and preserves edge labels", async () => {
    const layoutModule = await import("../lib/feature-flow-layout").catch(() => null);
    expect(layoutModule, "the automatic layout module should exist").not.toBeNull();
    if (!layoutModule) return;

    const result = await layoutModule.layoutFeatureFlow(buildFeatureFlow(stepped));
    const first = result.nodes.find((node) => node.id === "HP-1")!;
    const second = result.nodes.find((node) => node.id === "HP-2")!;

    expect(second.y).toBeGreaterThan(first.y);
    expect(result.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-1", label: "Visitor" }));
    expect(result.edges).toContainEqual(expect.objectContaining({ from: "HP-1", to: "HP-2" }));
  });

  it("keeps source scenarios and condition labels when adapting the graph for rendering", async () => {
    const layoutModule = await import("../lib/feature-flow-layout");
    const adapter = (layoutModule as unknown as Record<string, unknown>).toReactFlowElements;
    expect(adapter, "the React Flow adapter should exist").toBeTypeOf("function");
    if (typeof adapter !== "function") return;

    const scenarios = stepped.map((scenario, index) => ({ ...scenario, id: index + 1, featureId: 1, source: "generated" as const, staleSince: null, staleChangeId: null }));
    const result = adapter(buildFeatureFlow(scenarios), scenarios);
    const first = result.nodes.find((node: { id: string }) => node.id === "HP-1");

    expect(first.data.scenarios).toHaveLength(1);
    expect(first.data.scenarios[0]).toMatchObject({ reference: "HP-1", outcome: "Repository linked" });
    expect(result.edges).toContainEqual(expect.objectContaining({ id: "start-HP-1", source: "start", target: "HP-1", label: "Visitor" }));
  });

  it("packs a wide stepless fan-out into multiple rows", async () => {
    const { layoutFeatureFlow } = await import("../lib/feature-flow-layout");
    const scenarios = Array.from({ length: 12 }, (_, index) => ({
      reference: `HP-${index + 1}`,
      context: `情境 ${index + 1}`,
      action: `操作 ${index + 1}`,
      outcome: "完成",
      category: "happy" as const,
      evidence: [],
    }));

    const result = await layoutFeatureFlow(buildFeatureFlow(scenarios));
    const { toReactFlowElements } = await import("../lib/feature-flow-layout");
    const elements = toReactFlowElements(result, []);
    const scenarioNodes = result.nodes.filter((node) => node.kind !== "start");

    expect(elements.edges.every((edge) => edge.type === "fanout")).toBe(true);
    expect(result.width).toBeLessThanOrEqual(1200);
    expect(result.presentation).toBe("fanout");
    expect(new Set(scenarioNodes.map((node) => node.y)).size).toBeGreaterThan(2);
    for (const [index, node] of scenarioNodes.entries()) {
      for (const other of scenarioNodes.slice(index + 1)) {
        const overlaps = node.x < other.x + 240 && node.x + 240 > other.x && node.y < other.y + 88 && node.y + 88 > other.y;
        expect(overlaps, `${node.id} should not overlap ${other.id}`).toBe(false);
      }
    }
  });
});
