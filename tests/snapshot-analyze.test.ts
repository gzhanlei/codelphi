import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisResult, analyzeWithAI } from "../lib/ai";
import type { StructuredCompletionClient } from "../lib/llm-client";
import type { AnalysisPartition } from "../lib/remote-analysis";
import type { RemoteSourceBackend } from "../lib/remote-source-index";
import { analyzeProductSnapshot } from "../lib/snapshot/analyze";
import type { SnapshotIdentity } from "../lib/snapshot/types";

const { partitionedSourcesMock, implementationSurfaceMock } = vi.hoisted(() => ({
  partitionedSourcesMock: vi.fn(),
  implementationSurfaceMock: vi.fn(),
}));

const identity: SnapshotIdentity = {
  source: "local",
  name: "fixture",
  target: "/tmp/fixture",
  revision: "a".repeat(40),
  branch: "main",
  message: "Initial product",
  committedAt: "2026-11-17T00:00:00Z",
  workingTreeDirty: false,
};

const client: StructuredCompletionClient = { complete: vi.fn(), displayName: "Host current model" };
const backend = { kind: "local_git" } as RemoteSourceBackend;

function partition(path: string, content: string): AnalysisPartition {
  return {
    slice: { files: [{ path }] },
    sources: [{ path, content }],
  } as AnalysisPartition;
}

function result(path: string, featureName: string): AnalysisResult {
  return {
    product: { description: "A traceable product", evidence: [{ path, startLine: 1 }] },
    release: { title: "Snapshot", summary: "Snapshot" },
    changes: [],
    features: [{ name: featureName, summary: `${featureName} summary`, scenarios: [{ reference: "HP-1", context: "User", action: "Uses product", outcome: "Succeeds", category: "happy", evidence: [{ path, startLine: 1 }] }] }],
  };
}

describe("one-off product snapshot analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    implementationSurfaceMock.mockResolvedValue([{ path: "a.ts", size: 20 }, { path: "b.ts", size: 20 }]);
  });

  it("uses the injected host client and merges evidence-safe partitions with naming continuity", async () => {
    partitionedSourcesMock.mockResolvedValue({
      partitions: [partition("a.ts", "1: export const a = true;"), partition("b.ts", "1: export const b = true;")],
      index: { scopeRoots: [] },
    });
    const analyze = vi.fn<typeof analyzeWithAI>(async (sources, _change, context) => {
      if (sources[0].path === "a.ts") return result("a.ts", "Alpha");
      expect(context?.previousFeatureNames).toContain("Alpha");
      expect(context?.client).toBe(client);
      expect(context?.billing).toBeUndefined();
      const second = result("b.ts", "Beta");
      second.features[0].scenarios.push({ reference: "HP-2", context: "Invalid", action: "Cites another partition", outcome: "Dropped", category: "error", evidence: [{ path: "a.ts", startLine: 1 }] });
      return second;
    });

    const progress: Array<{ stage: string; status: string; current?: number; total?: number }> = [];
    const analysis = await analyzeProductSnapshot({
      backend,
      identity,
      productName: "Fixture",
      outputLanguage: "en",
      client,
      analyze,
      loadPartitions: partitionedSourcesMock,
      enumerateSurface: implementationSurfaceMock,
      onProgress: (event) => progress.push(event),
    });

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analysis.result.features.map((feature) => feature.name)).toEqual(["Alpha", "Beta"]);
    expect(analysis.result.features[1].scenarios).toHaveLength(1);
    expect(analysis.passes[1].sanitize.droppedScenarios).toBe(1);
    expect(analysis.warnings.some((warning) => warning.code === "evidence_dropped")).toBe(true);
    expect(analysis.language).toBe("en");
    expect(analysis.modelName).toBe("Host current model");
    const request = partitionedSourcesMock.mock.calls[0][0];
    expect(request.backend).toBe(backend);
    expect(request.repository.revision).toBe(identity.revision);
    expect(request.diffPaths).toBeUndefined();
    expect(request.access).toEqual({});
    expect(progress).toContainEqual({ stage: "plan", status: "complete", total: 2 });
    expect(progress.filter((event) => event.stage === "partition" && event.status === "start")).toHaveLength(2);
    expect(progress.filter((event) => event.stage === "partition" && event.status === "complete")).toHaveLength(2);
    expect(progress).toContainEqual(expect.objectContaining({ stage: "presentation", status: "fallback" }));
  });

  it("retries once and records the retry without a billing context", async () => {
    partitionedSourcesMock.mockResolvedValue({ partitions: [partition("a.ts", "1: export const a = true;")], index: { scopeRoots: [] } });
    const analyze = vi.fn<typeof analyzeWithAI>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockImplementationOnce(async (_sources, _change, context) => {
        expect(context?.client).toBe(client);
        expect(context?.billing).toBeUndefined();
        return result("a.ts", "Alpha");
      });
    const progress: Array<{ stage: string; status: string }> = [];
    const analysis = await analyzeProductSnapshot({ backend, identity, productName: "Fixture", outputLanguage: "zh-CN", client, analyze, loadPartitions: partitionedSourcesMock, enumerateSurface: implementationSurfaceMock, onProgress: (event) => progress.push(event) });
    expect(analysis.passes[0].retries).toBe(1);
    expect(progress).toContainEqual(expect.objectContaining({ stage: "partition", status: "retry", current: 1, total: 1 }));
    expect(analysis.warnings.some((warning) => warning.code === "extraction_retry")).toBe(true);
  });

  it("fails instead of emitting a successful report when all candidates are rejected", async () => {
    partitionedSourcesMock.mockResolvedValue({ partitions: [partition("a.ts", "1: export const a = true;")], index: { scopeRoots: [] } });
    const analyze = vi.fn<typeof analyzeWithAI>(async () => result("missing.ts", "Hallucinated"));
    await expect(analyzeProductSnapshot({ backend, identity, productName: "Fixture", outputLanguage: "en", client, analyze, loadPartitions: partitionedSourcesMock, enumerateSurface: implementationSurfaceMock })).rejects.toMatchObject({ code: "no_valid_spec" });
  });

  it("marks a dirty working tree without reading its uncommitted content", async () => {
    partitionedSourcesMock.mockResolvedValue({ partitions: [partition("a.ts", "1: export const a = true;")], index: { scopeRoots: [] } });
    const analyze = vi.fn<typeof analyzeWithAI>(async () => result("a.ts", "Alpha"));
    const analysis = await analyzeProductSnapshot({ backend, identity: { ...identity, workingTreeDirty: true }, productName: "Fixture", outputLanguage: "en", client, analyze, loadPartitions: partitionedSourcesMock, enumerateSurface: implementationSurfaceMock });
    expect(analysis.warnings).toContainEqual(expect.objectContaining({ code: "working_tree_dirty" }));
    expect(analysis.identity.revision).toBe(identity.revision);
  });
});
