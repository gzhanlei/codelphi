import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpecFeature } from "../lib/spec-diff";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";
import { scenarioFingerprint } from "../lib/semantic-feature-flow";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  loadRecords: vi.fn(),
  save: vi.fn(),
  copy: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../lib/feature-flow-generation", () => ({ generateFeatureFlowGraph: mocks.generate }));
vi.mock("../lib/feature-flow-store", () => ({
  loadVersionFeatureRecords: mocks.loadRecords,
  saveFeatureFlowGraph: mocks.save,
  copyInheritedFeatureFlowGraphs: mocks.copy,
}));
vi.mock("../lib/db", () => ({ defaultExecute: mocks.execute, getDb: () => ({ execute: mocks.execute }) }));

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
const records = [
  { id: 101, stableKey: "a", feature: { name: "A", summary: "A", scenarios } },
  { id: 102, stableKey: "b", feature: { name: "B", summary: "B", scenarios } },
];

describe("feature flow service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generate.mockResolvedValue(graph);
    mocks.loadRecords.mockResolvedValue(records);
    mocks.copy.mockResolvedValue(0);
    mocks.execute.mockResolvedValue([[]]);
  });

  it("generates every final feature graph in full mode", async () => {
    const { syncFeatureFlowsForVersion } = await import("../lib/feature-flow-service").catch(() => ({ syncFeatureFlowsForVersion: undefined }));
    expect(syncFeatureFlowsForVersion, "version synchronization should exist").toBeTypeOf("function");
    if (!syncFeatureFlowsForVersion) return;

    const result = await syncFeatureFlowsForVersion({ specVersionId: 42, repositoryId: 3 });
    expect(result).toEqual({ generated: 2, copied: 0, failed: 0 });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 101, graph, scenarioFingerprint(scenarios));
  });

  it("copies inherited graphs and generates only affected features in incremental mode", async () => {
    const { syncFeatureFlowsForVersion } = await import("../lib/feature-flow-service");
    mocks.execute.mockImplementation(async (sql: string) => sql.includes("FROM spec_versions WHERE repository_id") ? [[{ id: 41 }]] : [[]]);
    mocks.copy.mockResolvedValue(1);

    const result = await syncFeatureFlowsForVersion({ specVersionId: 42, repositoryId: 3, affectedKeys: new Set(["a"]) });
    expect(result).toEqual({ generated: 1, copied: 1, failed: 0 });
    expect(mocks.copy).toHaveBeenCalledWith(expect.anything(), 41, 42);
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate).toHaveBeenCalledWith(records[0].feature, undefined);
  });

  it("isolates one feature generation failure without rolling back others", async () => {
    const { syncFeatureFlowsForVersion } = await import("../lib/feature-flow-service");
    mocks.generate.mockRejectedValueOnce(new Error("invalid graph"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await syncFeatureFlowsForVersion({ specVersionId: 42, repositoryId: 3 });
      expect(result).toEqual({ generated: 1, copied: 0, failed: 1 });
      expect(mocks.save).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("regenerates from final workbench scenarios and saves through stable key", async () => {
    const { regenerateFeatureFlowForWorkbenchFeature } = await import("../lib/feature-flow-service");
    const manualScenarios = [{ ...scenarios[0], source: "manual" as const }, scenarios[1]];
    mocks.execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN products p ON")) return [[{ id: 9176, name: "A", summary: "A", source: "manual", specVersionId: 42 }]];
      if (sql.includes("FROM scenarios WHERE feature_id = ?")) return [[{ ...manualScenarios[0], featureId: 9176, evidence: "[]" }, { ...manualScenarios[1], featureId: 9176, evidence: "[]" }]];
      return [[]];
    });

    const result = await regenerateFeatureFlowForWorkbenchFeature(9176, { runId: null, accountId: null, chargeComponent: "main", callKind: "feature_flow_backfill" });
    expect(result).toEqual(graph);
    expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({ name: "A", scenarios: expect.arrayContaining([expect.objectContaining({ source: "manual" })]) }), { runId: null, accountId: null, chargeComponent: "main", callKind: "feature_flow_backfill" });
    expect(mocks.save).toHaveBeenCalledWith(expect.anything(), 101, graph, scenarioFingerprint(manualScenarios));
  });
});
