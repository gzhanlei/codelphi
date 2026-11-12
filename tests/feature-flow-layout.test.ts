import { describe, expect, it } from "vitest";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";
import type { ScenarioRow } from "../lib/types";

const graph: FeatureFlowGraph = {
  entryNodeIds: ["start"],
  nodes: [
    { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
    { id: "validate", kind: "action", title: "校验构建产物与参数", scenarioRefs: ["HP-1"] },
    { id: "warmup", kind: "action", title: "预热", scenarioRefs: ["HP-1"] },
    { id: "measure", kind: "action", title: "执行 N 次测量并汇总完整结果", scenarioRefs: ["HP-1", "HP-2"] },
    { id: "skip", kind: "action", title: "跳过 RSS 检查并继续", scenarioRefs: ["EC-1"] },
    { id: "evaluate", kind: "decision", title: "评估性能门槛", scenarioRefs: ["HP-2"] },
    { id: "pass", kind: "end", title: "PASS / 退出 0", scenarioRefs: ["HP-2"] },
    { id: "fail", kind: "end", title: "FAIL / 退出 1", scenarioRefs: ["ER-1"] },
  ],
  edges: [
    { id: "e1", from: "start", to: "validate", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e2", from: "validate", to: "warmup", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e3", from: "warmup", to: "measure", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e4", from: "measure", to: "evaluate", kind: "sequence", scenarioRefs: ["HP-2"] },
    { id: "e5", from: "measure", to: "skip", kind: "branch", label: "缺少 /usr/bin/time 峰值输出", scenarioRefs: ["EC-1"] },
    { id: "e6", from: "skip", to: "evaluate", kind: "sequence", scenarioRefs: ["EC-1"] },
    { id: "e7", from: "evaluate", to: "pass", kind: "branch", label: "全部通过", scenarioRefs: ["HP-2"] },
    { id: "e8", from: "evaluate", to: "fail", kind: "branch", label: "任一指标超限", scenarioRefs: ["ER-1"] },
    { id: "e9", from: "evaluate", to: "warmup", kind: "retry", label: "失败重试", scenarioRefs: ["ER-1"] },
  ],
  excludedScenarios: [{ reference: "HP-3", reason: "documentary" }],
};

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe("semantic feature flow layout", () => {
  it("uses routed vertical paths and reserves node and label space", async () => {
    const { layoutSemanticFeatureFlow } = await import("../lib/feature-flow-layout").catch(() => ({ layoutSemanticFeatureFlow: undefined }));
    expect(layoutSemanticFeatureFlow, "semantic layout should exist").toBeTypeOf("function");
    if (!layoutSemanticFeatureFlow) return;
    const result = await layoutSemanticFeatureFlow(graph);
    const byId = new Map(result.nodes.map((node) => [node.id, node]));

    expect(byId.get("warmup")!.y).toBeGreaterThan(byId.get("validate")!.y);
    expect(byId.get("measure")!.y).toBeGreaterThan(byId.get("warmup")!.y);
    expect(byId.get("evaluate")!.y).toBeGreaterThan(byId.get("measure")!.y);
    for (const [index, node] of result.nodes.entries()) {
      for (const other of result.nodes.slice(index + 1)) expect(overlaps(node, other)).toBe(false);
      expect(node.width).toBeGreaterThan(100);
      expect(node.height).toBeGreaterThanOrEqual(56);
    }
    for (const edge of result.edges) {
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
      for (const point of edge.points) {
        expect(point.x).toBeGreaterThanOrEqual(40);
        expect(point.y).toBeGreaterThanOrEqual(40);
      }
      if (edge.label) {
        expect(edge.labelPosition).toBeDefined();
        expect(edge.labelPosition!.x).toBeGreaterThanOrEqual(40);
        expect(edge.labelPosition!.y).toBeGreaterThanOrEqual(40);
        for (const node of result.nodes) expect(overlaps(edge.labelPosition!, node)).toBe(false);
      }
    }
  });

  it("sizes long titles instead of clipping them", async () => {
    const { layoutSemanticFeatureFlow } = await import("../lib/feature-flow-layout");
    const long = structuredClone(graph);
    long.nodes[1].title = "校验所有构建产物、命令行参数、缓存目录和运行前置条件";
    long.nodes[2].title = "预热";
    const result = await layoutSemanticFeatureFlow(long);
    expect(result.nodes.find((node) => node.id === "validate")!.height).toBeGreaterThan(result.nodes.find((node) => node.id === "warmup")!.height);
  });

  it("maps every cited scenario into node details and uses routed edges", async () => {
    const { layoutSemanticFeatureFlow, toReactFlowElements } = await import("../lib/feature-flow-layout");
    const scenarios = ["HP-1", "HP-2", "EC-1", "ER-1"].map((reference, index): ScenarioRow => ({
      id: index + 1, featureId: 1, reference, context: "情境", action: "操作", outcome: "结果",
      category: reference === "ER-1" ? "error" : reference === "EC-1" ? "edge" : "happy",
      source: "generated", evidence: [], staleSince: null, staleChangeId: null,
    }));
    const result = await layoutSemanticFeatureFlow(graph);
    const elements = toReactFlowElements(result, scenarios);
    const measure = elements.nodes.find((node) => node.id === "measure")!;
    expect(measure.data.scenarios.map((scenario) => scenario.reference)).toEqual(["HP-1", "HP-2"]);
    expect(elements.edges.every((edge) => edge.type === "routed")).toBe(true);
    expect(elements.edges[0].data?.points).toBeDefined();
  });
});
