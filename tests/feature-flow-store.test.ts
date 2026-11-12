import { beforeEach, describe, expect, it } from "vitest";
import type { Execute } from "../lib/db";
import type { SpecFeature, SpecScenario } from "../lib/spec-diff";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";
import { scenarioFingerprint } from "../lib/semantic-feature-flow";

let api: typeof import("../lib/feature-flow-store") | null = null;

beforeEach(async () => {
  api = await import("../lib/feature-flow-store").catch(() => null);
  expect(api, "feature flow store should exist").not.toBeNull();
});

const scenarios: SpecScenario[] = [
  { reference: "HP-1", context: "已构建", action: "预热", outcome: "缓存就绪", category: "happy", source: "generated", step: 1, evidence: [] },
  { reference: "HP-2", context: "缓存就绪", action: "执行测量", outcome: "完成", category: "happy", source: "generated", step: 2, evidence: [] },
];
const feature: SpecFeature = { name: "固定性能门槛", summary: "性能门槛", source: "generated", scenarios };
const graph: FeatureFlowGraph = {
  entryNodeIds: ["start"],
  nodes: [
    { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
    { id: "warmup", kind: "action", title: "预热", scenarioRefs: ["HP-1"] },
    { id: "measure", kind: "action", title: "执行测量", scenarioRefs: ["HP-2"] },
  ],
  edges: [
    { id: "e1", from: "start", to: "warmup", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e2", from: "warmup", to: "measure", kind: "sequence", scenarioRefs: ["HP-2"] },
  ],
  excludedScenarios: [],
};

type MemoryRow = Record<string, unknown>;

function memoryExecute(state: { features: MemoryRow[]; scenarios: MemoryRow[]; flows: MemoryRow[] }): Execute {
  return async (sql: string, parameters: Array<string | number | null>) => {
    if (sql.includes("FROM spec_features WHERE spec_version_id = ?")) {
      return [state.features.filter((row) => row.versionId === parameters[0])];
    }
    if (sql.includes("FROM spec_scenarios WHERE spec_feature_id IN")) {
      return [state.scenarios.filter((row) => parameters.includes(Number(row.featureId)))];
    }
    if (sql.includes("FROM spec_feature_flows ff JOIN spec_features sf") && sql.includes("sf.spec_version_id = ?")) {
      const stableKeys = new Map(state.features.map((row) => [row.id, row.stableKey]));
      return [state.flows.filter((row) => stableKeys.has(row.specFeatureId) && state.features.some((feature) => feature.id === row.specFeatureId && feature.versionId === parameters[0])).map((row) => ({ ...row, stableKey: stableKeys.get(row.specFeatureId) }))];
    }
    if (sql.startsWith("INSERT INTO spec_feature_flows")) {
      const [specFeatureId, graphJson, fingerprint] = parameters;
      const existing = state.flows.find((row) => row.specFeatureId === specFeatureId);
      if (existing) Object.assign(existing, { graphJson, fingerprint });
      else state.flows.push({ specFeatureId, graphJson, fingerprint });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  };
}

function versionRows(versionId: number, currentFeature: SpecFeature = feature) {
  return {
    features: [{ id: versionId * 100, versionId, stableKey: "固定性能门槛", name: currentFeature.name, summary: currentFeature.summary, parentKey: null, source: currentFeature.source }],
    scenarios: currentFeature.scenarios.map((scenario) => ({ ...scenario, featureId: versionId * 100, evidence: JSON.stringify(scenario.evidence) })),
    flows: [] as MemoryRow[],
  };
}

describe("feature flow store", () => {
  it("upserts a validated graph for one spec feature", async () => {
    const state = versionRows(1);
    const execute = memoryExecute(state);
    const fingerprint = scenarioFingerprint(feature.scenarios);
    await api!.saveFeatureFlowGraph(execute, 100, graph, fingerprint);
    await api!.saveFeatureFlowGraph(execute, 100, graph, fingerprint);

    expect(state.flows).toHaveLength(1);
    expect(state.flows[0]).toMatchObject({ specFeatureId: 100, graphJson: JSON.stringify(graph), fingerprint });
  });

  it("loads a graph only when the final scenario fingerprint matches", async () => {
    const state = versionRows(1);
    state.flows.push({ specFeatureId: 100, graphJson: JSON.stringify(graph), fingerprint: scenarioFingerprint(scenarios) });
    const execute = memoryExecute(state);

    const loaded = await api!.loadFeatureFlowGraphs(execute, 1, [feature]);
    expect(loaded.get("固定性能门槛")).toEqual(graph);

    const manual = { ...feature, scenarios: [{ ...scenarios[0], source: "manual" as const }, scenarios[1]] };
    const stale = await api!.loadFeatureFlowGraphs(execute, 1, [manual]);
    expect(stale.size).toBe(0);
  });

  it("copies an inherited graph only when stable key and fingerprint both match", async () => {
    const previous = versionRows(1);
    previous.flows.push({ specFeatureId: 100, graphJson: JSON.stringify(graph), fingerprint: scenarioFingerprint(scenarios) });
    const next = versionRows(2);
    const execute = memoryExecute({ features: [...previous.features, ...next.features], scenarios: [...previous.scenarios, ...next.scenarios], flows: previous.flows });

    const copied = await api!.copyInheritedFeatureFlowGraphs(execute, 1, 2);
    expect(copied).toBe(1);
    expect(next.flows).toHaveLength(0);
    const allFlows = previous.flows;
    expect(allFlows.some((row) => row.specFeatureId === 200)).toBe(true);
  });

  it("does not copy when the new version changed the scenario content", async () => {
    const previous = versionRows(1);
    previous.flows.push({ specFeatureId: 100, graphJson: JSON.stringify(graph), fingerprint: scenarioFingerprint(scenarios) });
    const changed = { ...feature, scenarios: [{ ...scenarios[0], action: "不同操作" }, scenarios[1]] };
    const next = versionRows(2, changed);
    const execute = memoryExecute({ features: [...previous.features, ...next.features], scenarios: [...previous.scenarios, ...next.scenarios], flows: previous.flows });

    expect(await api!.copyInheritedFeatureFlowGraphs(execute, 1, 2)).toBe(0);
    expect(previous.flows.some((row) => row.specFeatureId === 200)).toBe(false);
  });

  it("loads version feature ids, stable keys and scenarios for generation", async () => {
    const state = versionRows(3);
    const records = await api!.loadVersionFeatureRecords(memoryExecute(state), 3);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 300, stableKey: "固定性能门槛", feature });
  });
});
