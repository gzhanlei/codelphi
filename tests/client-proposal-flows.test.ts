import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecFeature } from "../lib/spec-diff";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";
import { scenarioFingerprint } from "../lib/semantic-feature-flow";

const mocks = vi.hoisted(() => ({
  loadRecords: vi.fn(),
  save: vi.fn(),
  saveError: vi.fn(),
  copy: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../lib/feature-flow-store", () => ({
  loadVersionFeatureRecords: mocks.loadRecords,
  saveFeatureFlowGraph: mocks.save,
  saveFeatureFlowError: mocks.saveError,
  copyInheritedFeatureFlowGraphs: mocks.copy,
}));
vi.mock("../lib/db", () => ({ defaultExecute: mocks.execute, getDb: () => ({ execute: mocks.execute }) }));

import { storeClientFlows } from "../lib/client-proposal/flows";

const scenarios: SpecFeature["scenarios"] = [
  { reference: "HP-1", context: "已构建", action: "预热", outcome: "缓存就绪", category: "happy", source: "generated", evidence: [] },
  { reference: "HP-2", context: "缓存就绪", action: "执行测量", outcome: "完成", category: "happy", source: "generated", evidence: [] },
];
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
/** 合并后落库的功能：客户端看到的是 HP-1、HP-2；这里多了一条人工编辑加进来的 EC-9。 */
const merged = [{ id: 101, stableKey: "a", feature: { name: "A", summary: "A", scenarios: [...scenarios, { reference: "EC-9", context: "人工", action: "补偿", outcome: "完成", category: "edge" as const, source: "manual" as const, evidence: [] }] } }];

describe("storeClientFlows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadRecords.mockResolvedValue(merged);
    mocks.copy.mockResolvedValue(0);
    mocks.save.mockResolvedValue(undefined);
    mocks.saveError.mockResolvedValue(undefined);
    mocks.execute.mockResolvedValue([[{ id: 77 }]]);
  });

  it("stores a client graph under the fingerprint of the scenarios that were actually merged", async () => {
    const summary = await storeClientFlows(mocks.execute, { repositoryId: 3, specVersionId: 80, flows: [{ featureStableKey: "a", fingerprint: "whatever-the-client-said", graph }] });
    expect(mocks.execute).toHaveBeenCalledWith("SELECT id FROM spec_versions WHERE repository_id = ? AND id < ? ORDER BY id DESC LIMIT 1", [3, 80]);
    expect(mocks.copy).toHaveBeenCalledWith(mocks.execute, 77, 80);
    expect(mocks.save).toHaveBeenCalledWith(mocks.execute, 101, graph, scenarioFingerprint(merged[0].feature.scenarios));
    expect(mocks.save).not.toHaveBeenCalledWith(mocks.execute, 101, graph, "whatever-the-client-said");
    expect(summary).toEqual({ inherited: 0, stored: 1, rejected: 0, unmatched: 0 });
  });

  it("records why a graph the merged scenarios do not support was refused, and does not regenerate it", async () => {
    // 客户端的图引用了 HP-9：合并后的功能里没有这一条（比如人工把它删了）。
    const stale: FeatureFlowGraph = { ...graph, nodes: [{ id: "start", kind: "start", title: "开始", scenarioRefs: [] }, { id: "x", kind: "action", title: "过期", scenarioRefs: ["HP-9"] }], edges: [{ id: "e1", from: "start", to: "x", kind: "sequence", scenarioRefs: ["HP-9"] }] };
    const summary = await storeClientFlows(mocks.execute, { repositoryId: 3, specVersionId: 80, flows: [{ featureStableKey: "a", fingerprint: "f", graph: stale }] });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveError).toHaveBeenCalledWith(mocks.execute, 101, "UNKNOWN_SCENARIO_REFERENCE", scenarioFingerprint(merged[0].feature.scenarios));
    expect(summary).toEqual({ inherited: 0, stored: 0, rejected: 1, unmatched: 0 });
  });

  it("drops a flow for a feature that did not survive the merge, without writing anything", async () => {
    const summary = await storeClientFlows(mocks.execute, { repositoryId: 3, specVersionId: 80, flows: [{ featureStableKey: "gone", fingerprint: "f", graph }] });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.saveError).not.toHaveBeenCalled();
    expect(summary).toEqual({ inherited: 0, stored: 0, rejected: 0, unmatched: 1 });
  });

  it("has nothing to inherit on a first version", async () => {
    mocks.execute.mockResolvedValue([[]]);
    const summary = await storeClientFlows(mocks.execute, { repositoryId: 3, specVersionId: 80, flows: [] });
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(summary).toEqual({ inherited: 0, stored: 0, rejected: 0, unmatched: 0 });
  });
});
