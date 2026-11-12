import { beforeEach, describe, expect, it } from "vitest";
import type { SpecScenario } from "../lib/spec-diff";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";

let api: typeof import("../lib/semantic-feature-flow") | null = null;

beforeEach(async () => {
  api = await import("../lib/semantic-feature-flow").catch(() => null);
  expect(api, "semantic feature flow module should exist").not.toBeNull();
});

const scenarios: SpecScenario[] = [
  { reference: "HP-1", context: "已构建", action: "预热", outcome: "缓存就绪", category: "happy", step: 1, source: "generated", evidence: [{ path: "scripts/performance-gate.ts", startLine: 47 }] },
  { reference: "HP-2", context: "缓存就绪", action: "执行测量", outcome: "完成", category: "happy", step: 2, source: "generated", evidence: [{ path: "scripts/performance-gate.ts", startLine: 89 }] },
  { reference: "ER-1", context: "失败", action: "重试测量", outcome: "返回测量步骤", category: "error", step: 2, source: "generated", evidence: [{ path: "scripts/performance-gate.ts", startLine: 55 }] },
];

function validGraph(): FeatureFlowGraph {
  return {
    entryNodeIds: ["start"],
    nodes: [
      { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
      { id: "warmup", kind: "action", title: "预热", scenarioRefs: ["HP-1"] },
      { id: "measure", kind: "action", title: "执行测量", scenarioRefs: ["HP-2"] },
      { id: "end", kind: "end", title: "完成", scenarioRefs: ["HP-2"] },
    ],
    edges: [
      { id: "e1", from: "start", to: "warmup", kind: "sequence", scenarioRefs: ["HP-1"] },
      { id: "e2", from: "warmup", to: "measure", kind: "sequence", scenarioRefs: ["HP-2"] },
      { id: "e3", from: "measure", to: "end", kind: "sequence", scenarioRefs: ["HP-2"] },
    ],
    excludedScenarios: [],
  };
}

function validationCode(graph: unknown, input: SpecScenario[] = scenarios) {
  try {
    api!.validateFeatureFlowGraph(graph, input);
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
}

describe("semantic feature flow validation", () => {
  it("accepts a reachable evidence-backed main path", () => {
    expect(api!.validateFeatureFlowGraph(validGraph(), scenarios)).toEqual(validGraph());
  });

  it("rejects unknown scenario references", () => {
    const graph = validGraph();
    graph.nodes[1].scenarioRefs = ["HP-404"];
    expect(validationCode(graph)).toBe("UNKNOWN_SCENARIO_REFERENCE");
  });

  it("rejects duplicate node ids", () => {
    const graph = validGraph();
    graph.nodes[1].id = "measure";
    expect(validationCode(graph)).toBe("DUPLICATE_NODE_ID");
  });

  it("rejects an edge with a missing endpoint", () => {
    const graph = validGraph();
    graph.edges[1].to = "missing";
    expect(validationCode(graph)).toBe("UNKNOWN_EDGE_ENDPOINT");
  });

  it("rejects unreachable nodes", () => {
    const graph = validGraph();
    graph.nodes.push({ id: "island", kind: "action", title: "孤岛", scenarioRefs: ["HP-1"] });
    expect(validationCode(graph)).toBe("UNREACHABLE_NODE");
  });

  it("accepts eight genuine independent entries (relaxed cap for multi-subflow features)", () => {
    const graph = validGraph();
    graph.entryNodeIds = ["start"];
    for (let index = 1; index <= 7; index += 1) {
      graph.nodes.push({ id: `entry-${index}`, kind: "action", title: `入口 ${index}`, scenarioRefs: ["HP-1"] });
      graph.edges.push({ id: `entry-edge-${index}`, from: "start", to: `entry-${index}`, kind: "sequence", scenarioRefs: ["HP-1"] });
    }
    expect(validationCode(graph)).toBeNull();
  });

  it("rejects more than eight independent entries", () => {
    const graph = validGraph();
    graph.entryNodeIds = ["start", "start", "start", "start", "start", "start", "start", "start", "start"];
    expect(validationCode(graph)).toBe("TOO_MANY_ENTRIES");
  });

  it("rejects an end node without scenario evidence", () => {
    const graph = validGraph();
    graph.nodes[3].scenarioRefs = [];
    expect(validationCode(graph)).toBe("NODE_EVIDENCE_MISSING");
  });

  it("rejects a cycle without retry evidence", () => {
    const graph = validGraph();
    graph.edges.push({ id: "cycle", from: "measure", to: "warmup", kind: "retry", scenarioRefs: ["HP-2"] });
    expect(validationCode(graph)).toBe("RETRY_EVIDENCE_MISSING");
  });

  it("accepts a retry backed by a retry scenario", () => {
    const graph = validGraph();
    graph.edges.push({ id: "retry", from: "measure", to: "warmup", kind: "retry", scenarioRefs: ["ER-1"] });
    expect(validationCode(graph)).toBeNull();
  });

  it("rejects graphs above the node cap", () => {
    const graph = validGraph();
    for (let index = 0; index < 22; index += 1) {
      const id = `extra-${index}`;
      graph.nodes.push({ id, kind: "action", title: `额外 ${index}`, scenarioRefs: ["HP-1"] });
      graph.edges.push({ id: `edge-${index}`, from: "measure", to: id, kind: "branch", label: "附加路径", scenarioRefs: ["HP-1"] });
    }
    expect(validationCode(graph)).toBe("TOO_MANY_NODES");
  });

  it("rejects a single action as a missing main chain", () => {
    const graph = validGraph();
    graph.nodes = [graph.nodes[0], graph.nodes[1]];
    graph.edges = [graph.edges[0]];
    expect(validationCode(graph)).toBe("MAIN_CHAIN_MISSING");
  });

  it("rejects a documentary-only graph instead of lowering the main-chain gate", () => {
    const graph = validGraph();
    graph.nodes = [graph.nodes[0]];
    graph.edges = [];
    graph.excludedScenarios = [
      { reference: "HP-1", reason: "documentary" },
      { reference: "HP-2", reason: "documentary" },
    ];
    expect(validationCode(graph)).toBe("MAIN_CHAIN_MISSING");
  });

  it("rejects more than eight outgoing start branches", () => {
    const graph = validGraph();
    for (let index = 0; index < 8; index += 1) {
      graph.nodes.push({ id: `entry-${index}`, kind: "action", title: `入口 ${index}`, scenarioRefs: ["HP-1"] });
      graph.edges.push({ id: `entry-edge-${index}`, from: "start", to: `entry-${index}`, kind: "sequence", scenarioRefs: ["HP-1"] });
    }
    expect(validationCode(graph)).toBe("TOO_MANY_ENTRIES");
  });
});

describe("scenario fingerprint", () => {
  it("is stable across scenario array order", () => {
    expect(api!.scenarioFingerprint(scenarios)).toBe(api!.scenarioFingerprint([...scenarios].reverse()));
  });

  it("changes when scenario content changes", () => {
    expect(api!.scenarioFingerprint(scenarios)).not.toBe(api!.scenarioFingerprint([{ ...scenarios[0], action: "不同操作" }, ...scenarios.slice(1)]));
  });

  it("changes when step or source changes", () => {
    expect(api!.scenarioFingerprint(scenarios)).not.toBe(api!.scenarioFingerprint([{ ...scenarios[0], step: 3 }, ...scenarios.slice(1)]));
    expect(api!.scenarioFingerprint(scenarios)).not.toBe(api!.scenarioFingerprint([{ ...scenarios[0], source: "manual" }, ...scenarios.slice(1)]));
  });
});
