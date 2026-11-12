import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecFeature } from "../lib/spec-diff";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";
import fixture from "./fixtures/repomap-performance-scenarios.json";

const { receipts } = vi.hoisted(() => ({ receipts: [] as Array<{ callKind?: string | null }> }));
vi.mock("../lib/billing/cost-receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/billing/cost-receipt")>();
  return { ...actual, recordLlmCallReceipt: vi.fn(async (input: { callKind?: string | null }) => { receipts.push(input); }) };
});

const feature = fixture as SpecFeature;
const candidate: FeatureFlowGraph = {
  entryNodeIds: ["start"],
  nodes: [
    { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
    { id: "validate", kind: "action", title: "校验构建产物与参数", scenarioRefs: ["HP-16"] },
    { id: "warmup", kind: "action", title: "预热", scenarioRefs: ["HP-1"] },
    { id: "measure", kind: "action", title: "执行 N 次测量", scenarioRefs: ["HP-10"] },
    { id: "summarize", kind: "action", title: "汇总测量结果", scenarioRefs: ["HP-11"] },
    { id: "evaluate", kind: "decision", title: "评估性能门槛", scenarioRefs: ["HP-2"] },
    { id: "skip-rss", kind: "action", title: "跳过 RSS 检查并继续", scenarioRefs: ["EC-2"] },
    { id: "missing-dist", kind: "error", title: "退出 2", scenarioRefs: ["ER-1"] },
    { id: "missing-receipt", kind: "error", title: "退出 1", scenarioRefs: ["ER-2"] },
    { id: "pass", kind: "end", title: "PASS / 退出 0", scenarioRefs: ["HP-12"] },
    { id: "fail", kind: "end", title: "FAIL / 退出 1", scenarioRefs: ["ER-3"] },
  ],
  edges: [
    { id: "e1", from: "start", to: "validate", kind: "sequence", scenarioRefs: ["HP-16"] },
    { id: "e2", from: "validate", to: "warmup", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e3", from: "warmup", to: "measure", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e4", from: "measure", to: "summarize", kind: "sequence", scenarioRefs: ["HP-10"] },
    { id: "e5", from: "summarize", to: "evaluate", kind: "sequence", scenarioRefs: ["HP-2"] },
    { id: "e6", from: "evaluate", to: "pass", kind: "branch", label: "全部通过", scenarioRefs: ["HP-12"] },
    { id: "e7", from: "validate", to: "missing-dist", kind: "branch", label: "缺少 dist", scenarioRefs: ["ER-1"] },
    { id: "e8", from: "measure", to: "missing-receipt", kind: "branch", label: "未生成 receipt", scenarioRefs: ["ER-2"] },
    { id: "e9", from: "measure", to: "skip-rss", kind: "branch", label: "缺少 /usr/bin/time", scenarioRefs: ["EC-2"] },
    { id: "e10", from: "skip-rss", to: "summarize", kind: "sequence", scenarioRefs: ["EC-2"] },
    { id: "e11", from: "evaluate", to: "fail", kind: "branch", label: "任一指标超限", scenarioRefs: ["ER-3"] },
  ],
  excludedScenarios: [
    { reference: "HP-15", reason: "documentary" },
    { reference: "EC-4", reason: "duplicate" },
    { reference: "EC-6", reason: "duplicate" },
    { reference: "EC-8", reason: "duplicate" },
  ],
};

function jsonResponse(graph: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(graph) } }], usage: {} }), { status: 200 });
}

describe("feature flow generation", () => {
  beforeEach(() => {
    receipts.length = 0;
    vi.stubEnv("AI_API_KEY", "key");
    vi.stubEnv("AI_MODEL", "test-model");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds a main path and excludes documentary and duplicate scenarios", async () => {
    const { generateFeatureFlowGraph } = await import("../lib/feature-flow-generation").catch(() => ({ generateFeatureFlowGraph: undefined }));
    expect(generateFeatureFlowGraph, "candidate generator should exist").toBeTypeOf("function");
    if (!generateFeatureFlowGraph) return;
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(candidate)));

    const graph = await generateFeatureFlowGraph(feature, { runId: 9, accountId: 3, chargeComponent: "main" });
    expect(graph.nodes.map((node) => node.title)).toEqual(expect.arrayContaining(["校验构建产物与参数", "预热", "执行 N 次测量", "汇总测量结果", "评估性能门槛"]));
    expect(graph.nodes.flatMap((node) => node.scenarioRefs)).not.toContain("HP-15");
    expect(graph.excludedScenarios).toEqual(expect.arrayContaining([{ reference: "EC-4", reason: "duplicate" }]));
    expect(receipts[0].callKind).toBe("feature_flow");
  });

  it("normalizes empty sequence labels before validation", async () => {
    const { generateFeatureFlowGraph } = await import("../lib/feature-flow-generation");
    const withEmptyLabels = structuredClone(candidate);
    withEmptyLabels.edges[0].label = "";
    withEmptyLabels.edges[1].label = "  ";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(withEmptyLabels)));

    const graph = await generateFeatureFlowGraph(feature);
    expect(graph.edges[0].label).toBeUndefined();
    expect(graph.edges[1].label).toBeUndefined();
  });

  it("retries once with validation feedback instead of accepting a partial graph", async () => {
    const { generateFeatureFlowGraph } = await import("../lib/feature-flow-generation");
    const invalid = structuredClone(candidate);
    invalid.nodes[4].scenarioRefs = ["HP-15"];
    const responses = [jsonResponse(invalid), jsonResponse(candidate)];
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return responses.shift()!;
    }));

    const graph = await generateFeatureFlowGraph(feature);
    expect(graph).toEqual(candidate);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("EXCLUDED_SCENARIO_IN_GRAPH");
  });

  it("rejects unknown references returned by the gateway", async () => {
    const { generateFeatureFlowGraph } = await import("../lib/feature-flow-generation");
    const invalid = structuredClone(candidate);
    invalid.nodes[1].scenarioRefs = ["HP-404"];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(invalid)));

    await expect(generateFeatureFlowGraph(feature)).rejects.toMatchObject({ code: "UNKNOWN_SCENARIO_REFERENCE" });
  });

  it("propagates gateway failures and records the feature_flow call kind", async () => {
    const { generateFeatureFlowGraph } = await import("../lib/feature-flow-generation");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway unavailable", { status: 500 })));

    await expect(generateFeatureFlowGraph(feature, { runId: 9, accountId: 3, chargeComponent: "main" })).rejects.toThrow();
    expect(receipts).toHaveLength(1);
    expect(receipts[0].callKind).toBe("feature_flow");
  });

  it("states the graph contract without repository-specific hardcoding", async () => {
    const { featureFlowPrompt } = await import("../lib/feature-flow-generation");
    const prompt = featureFlowPrompt(feature);
    expect(prompt).toContain("24");
    expect(prompt).toContain("禁止未归属场景默认连接 START");
    expect(prompt).toContain("每条边都必须引用当前功能的场景");
    expect(featureFlowPrompt({ name: "任意功能", summary: "任意摘要", scenarios: [] })).not.toContain("RepoMap");
  });
});
