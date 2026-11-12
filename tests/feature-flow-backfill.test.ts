import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";

vi.mock("../lib/feature-flow-service", () => ({ regenerateFeatureFlowForWorkbenchFeature: vi.fn() }));

const graph: FeatureFlowGraph = {
  entryNodeIds: ["start"],
  nodes: [
    { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
    { id: "a", kind: "action", title: "预热", scenarioRefs: ["HP-1"] },
    { id: "b", kind: "action", title: "执行", scenarioRefs: ["HP-2"] },
  ],
  edges: [
    { id: "e1", from: "start", to: "a", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e2", from: "a", to: "b", kind: "sequence", scenarioRefs: ["HP-2"] },
  ],
  excludedScenarios: [{ reference: "HP-3", reason: "documentary" }],
};

describe("feature flow backfill CLI", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("regenerates one workbench feature with backfill billing", async () => {
    const { runFeatureFlowBackfill } = await import("../scripts/feature-flow-backfill").catch(() => ({ runFeatureFlowBackfill: undefined }));
    expect(runFeatureFlowBackfill, "backfill runner should exist").toBeTypeOf("function");
    if (!runFeatureFlowBackfill) return;
    const regenerate = vi.fn(async () => graph);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(runFeatureFlowBackfill(["--feature-id", "9176"], regenerate)).resolves.toBe(0);
    expect(regenerate).toHaveBeenCalledWith(9176, { runId: null, accountId: null, chargeComponent: "main", callKind: "feature_flow_backfill" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("featureId=9176"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("nodes=3"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("edges=2"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("excluded=1"));
  });

  it.each([
    ["--feature-id", ""],
    ["--feature-id"],
    ["--feature-id", "abc"],
    ["--feature-id", "0"],
    ["--feature-id", "-1"],
    ["--feature-id", "9176", "--feature-id", "9177"],
    ["--unknown", "9176"],
  ])("rejects invalid arguments %j without calling the service", async (...argv: string[]) => {
    const { runFeatureFlowBackfill } = await import("../scripts/feature-flow-backfill");
    const regenerate = vi.fn(async () => graph);
    await expect(runFeatureFlowBackfill(argv, regenerate)).resolves.toBe(2);
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("runs the CLI entry in the container's CJS mode without top-level await", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const result: { code?: number; stderr: string } = await promisify(execFile)(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/feature-flow-backfill.ts", "--feature-id", "0"], { cwd: process.cwd(), env: { ...process.env, TMPDIR: "/tmp" } }).then(
      ({ stderr }) => ({ stderr }),
      (error: { code?: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
    );

    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("Top-level await");
  });

  it("returns 1 and identifies the feature when generation fails", async () => {
    const { runFeatureFlowBackfill } = await import("../scripts/feature-flow-backfill");
    const regenerate = vi.fn(async () => { throw new Error("gateway failed"); });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runFeatureFlowBackfill(["--feature-id", "9176"], regenerate)).resolves.toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("featureId=9176"), expect.anything());
    expect(error.mock.calls.flat().join(" ")).not.toContain("AI_API_KEY");
  });
});
