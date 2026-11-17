import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSnapshotTarget } from "../lib/snapshot/target";
import { executeSnapshotWorkOrder, finalizeSnapshotAnalysis, prepareSnapshotAnalysis } from "../lib/snapshot/workflow";
import type { StructuredCompletionClient } from "../lib/llm-client";

const exec = promisify(execFile);
const roots: string[] = [];
const content = JSON.stringify({
  product: { description: "Packaged product", evidence: [{ path: "index.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [],
  features: [{
    name: "Packaged feature",
    summary: "Feature",
    scenarios: [{
      reference: "HP-1",
      context: "User",
      action: "Runs feature",
      outcome: "Succeeds",
      category: "happy",
      evidence: [{ path: "index.ts", startLine: 1 }],
    }],
  }],
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-workflow-repo-"));
  roots.push(root);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "config", "user.email", "radar@example.test"]);
  await exec("git", ["-C", root, "config", "user.name", "Radar Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "workflow-fixture" }));
  await writeFile(join(root, "index.ts"), "export const feature = true;\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("snapshot preparation and finalization", () => {
  it("prepares fixed-revision work orders without a model client and finalizes shared results", async () => {
    const target = await resolveSnapshotTarget(await repository());
    const prepared = await prepareSnapshotAnalysis({
      backend: target.backend,
      identity: target.identity,
      productName: target.identity.name,
      outputLanguage: "en",
    });

    expect(prepared.identity.revision).toBe(target.identity.revision);
    expect(prepared.workOrders.length).toBeGreaterThan(0);
    expect(prepared.workOrders[0].messages.length).toBeGreaterThan(0);
    expect(prepared.workOrders[0].allowPaths).toContain("index.ts");

    const client: StructuredCompletionClient = { complete: vi.fn(async () => content), displayName: "Host current model" };
    const execution = await executeSnapshotWorkOrder(prepared.workOrders[0], { client, previousFeatureNames: [] });
    const analysis = await finalizeSnapshotAnalysis(prepared, [execution], { modelName: "Host current model" });

    expect(analysis.result.features.map((feature) => feature.name)).toEqual(["Packaged feature"]);
    expect(analysis.presentation?.coreCapabilities.length).toBeGreaterThan(0);
    expect(analysis.coverage.implFilesAssembled).toBeGreaterThan(0);
    expect(vi.mocked(client.complete).mock.calls[0][0]).toEqual(prepared.workOrders[0].messages);
    await target.cleanup();
  });

  it("rejects missing or invalid results instead of producing a report", async () => {
    const target = await resolveSnapshotTarget(await repository());
    const prepared = await prepareSnapshotAnalysis({ backend: target.backend, identity: target.identity, productName: target.identity.name, outputLanguage: "en" });

    await expect(finalizeSnapshotAnalysis(prepared, [], { modelName: "Host" })).rejects.toMatchObject({ code: "no_valid_spec" });
    const client: StructuredCompletionClient = { complete: vi.fn(async () => {
      const invalid = JSON.parse(content);
      invalid.release.title = "";
      return JSON.stringify(invalid);
    }) };
    await expect(executeSnapshotWorkOrder(prepared.workOrders[0], { client, previousFeatureNames: [] })).rejects.toThrow();
    await target.cleanup();
  });
});
