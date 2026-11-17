import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { completeSnapshotWorkspace, finalizeSnapshotWorkspace, prepareSnapshotWorkspace, readSnapshotWorkOrder, writeSnapshotResult } from "../lib/snapshot/workspace";
import { resolveCompletionBackend } from "../lib/snapshot/host-ai";
import { main } from "../scripts/snapshot";

const exec = promisify(execFile);
const roots: string[] = [];
const validResult = JSON.stringify({
  product: { description: "Packaged product", evidence: [{ path: "index.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [],
  features: [{
    name: "Packaged feature",
    summary: "Feature",
    scenarios: [{ reference: "HP-1", context: "User", action: "Runs feature", outcome: "Succeeds", category: "happy", evidence: [{ path: "index.ts", startLine: 1 }] }],
  }],
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-workspace-repo-"));
  roots.push(root);
  await exec("git", ["-C", root, "init", "-b", "main"]);
  await exec("git", ["-C", root, "config", "user.email", "radar@example.test"]);
  await exec("git", ["-C", root, "config", "user.name", "Radar Test"]);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "workspace-fixture" }));
  await writeFile(join(root, "index.ts"), "export const feature = true;\n");
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-radar-workspace-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host-native snapshot workspace", () => {
  it("prepares versioned work orders and finalizes host results into one HTML", async () => {
    const directory = await workspace();
    const prepared = await prepareSnapshotWorkspace({ directory, target: await repository(), outputLanguage: "en" });
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    expect(manifest.contractVersion).toBe(prepared.manifest.contractVersion);
    expect(manifest.workOrderIds).toHaveLength(1);
    expect(manifest.repositoryRoot).toBeTruthy();

    await writeSnapshotResult(directory, manifest.workOrderIds[0], validResult);
    const finalized = await finalizeSnapshotWorkspace(directory);
    expect(finalized.html).toContain('<html lang="en">');
    expect(finalized.html).toContain("Packaged feature");
    expect(finalized.html).toContain("index.ts");
  });

  it("identifies missing, duplicate, invalid, and incompatible results without emitting HTML", async () => {
    const directory = await workspace();
    const prepared = await prepareSnapshotWorkspace({ directory, target: await repository(), outputLanguage: "en" });
    const id = prepared.manifest.workOrderIds[0];

    await expect(finalizeSnapshotWorkspace(directory)).rejects.toThrow(id);
    await writeSnapshotResult(directory, id, validResult);
    await expect(writeSnapshotResult(directory, id, validResult)).rejects.toThrow();

    const invalid = JSON.parse(validResult);
    invalid.release.title = "";
    await rm(join(directory, "results", `${id}.json`), { force: true });
    await writeSnapshotResult(directory, id, JSON.stringify(invalid));
    await expect(finalizeSnapshotWorkspace(directory)).rejects.toThrow();
    await rm(join(directory, "radar.html"), { force: true });

    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    manifest.contractVersion = "0.0.0-incompatible";
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await expect(finalizeSnapshotWorkspace(directory)).rejects.toThrow("0.0.0-incompatible");
  });

  it("runs prepare and finalize subcommands without a host completion interface", async () => {
    const directory = await workspace();
    const target = await repository();
    expect(await main(["prepare", target, "--workdir", directory])).toBe(0);
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    await writeSnapshotResult(directory, manifest.workOrderIds[0], validResult);
    expect(await main(["finalize", "--workdir", directory])).toBe(0);
    expect(await readFile(join(directory, "radar.html"), "utf8")).toContain("Packaged feature");
  });

  it("preserves completed results when preparing an existing workspace again", async () => {
    const directory = await workspace();
    const target = await repository();
    const prepared = await prepareSnapshotWorkspace({ directory, target, outputLanguage: "en" });
    const id = prepared.manifest.workOrderIds[0];
    await writeSnapshotResult(directory, id, validResult);
    const resultPath = join(directory, "results", `${id}.json`);

    await prepareSnapshotWorkspace({ directory, target, outputLanguage: "en" });
    expect(await readFile(resultPath, "utf8")).toBe(validResult);
  });

  it("keeps the repository after a failed finalization and cleans it only after success", async () => {
    const directory = await workspace();
    const target = await repository();
    const prepared = await prepareSnapshotWorkspace({ directory, target, outputLanguage: "en" });
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cleanupRoot = manifest.repositoryRoot;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const id = prepared.manifest.workOrderIds[0];
    const invalid = JSON.parse(validResult);
    invalid.features[0].scenarios[0].evidence[0].path = "missing.ts";
    await writeSnapshotResult(directory, id, JSON.stringify(invalid));

    await expect(finalizeSnapshotWorkspace(directory)).rejects.toMatchObject({ code: "no_valid_spec" });
    expect(await readFile(manifestPath, "utf8")).toContain(manifest.repositoryRoot);
    await rm(join(directory, "results", `${id}.json`), { force: true });
    await writeSnapshotResult(directory, id, validResult);
    await finalizeSnapshotWorkspace(directory);
    await expect(readFile(join(manifest.repositoryRoot, ".git", "HEAD"), "utf8")).rejects.toThrow();
  });

  it("rejects preparing a different target in the same workspace", async () => {
    const directory = await workspace();
    await prepareSnapshotWorkspace({ directory, target: await repository(), outputLanguage: "en" });
    await expect(prepareSnapshotWorkspace({ directory, target: await repository(), outputLanguage: "en" })).rejects.toThrow("workspace_target_mismatch");
  });

  it("adds completed feature names to later work-order messages", async () => {
    const directory = await workspace();
    const prepared = await prepareSnapshotWorkspace({ directory, target: await repository(), outputLanguage: "en" });
    const firstId = prepared.manifest.workOrderIds[0];
    const secondId = "partition-002";
    const first = await readFile(join(directory, "work-orders", `${firstId}.json`), "utf8");
    await writeFile(join(directory, "work-orders", `${secondId}.json`), first);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.workOrderIds.push(secondId);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeSnapshotResult(directory, firstId, validResult);

    const second = await readSnapshotWorkOrder(directory, secondId);
    expect(second.messages[1].content).toContain("Feature list from the previous spec");
    expect(second.messages[1].content).toContain("Packaged feature");
  });

  it("completes work orders through a host bridge and finalizes the report", async () => {
    const directory = await workspace();
    const prepared = await prepareSnapshotWorkspace({ directory, target: await repository(), outputLanguage: "en" });
    expect(prepared.manifest.workOrderIds).toHaveLength(1);

    const bridgeScript = `const fs=require("fs");const d=JSON.parse(fs.readFileSync(0,"utf8"));if(!d.messages||!d.messages.length)process.exit(9);const result=${JSON.stringify(JSON.parse(validResult))};process.stdout.write(JSON.stringify({content:JSON.stringify(result)}));`;
    const backend = resolveCompletionBackend({
      environment: { CODELPHI_HOST_AI_COMMAND: process.execPath, CODELPHI_HOST_AI_ARGS_JSON: JSON.stringify(["-e", bridgeScript]) },
      host: "TestHost",
    });
    if (backend.kind !== "host") throw new Error("expected host bridge backend");
    const progress: string[] = [];
    const outcome = await completeSnapshotWorkspace({ directory, client: backend.client, concurrency: 2, onProgress: (message) => progress.push(message) });
    expect(outcome.completed).toEqual(prepared.manifest.workOrderIds);
    expect(outcome.failed).toEqual([]);

    const finalized = await finalizeSnapshotWorkspace(directory);
    expect(finalized.html).toContain("Packaged feature");

    // 断点续跑：已有结果时 complete 全部跳过。
    const rerun = await completeSnapshotWorkspace({ directory, client: backend.client });
    expect(rerun.completed).toEqual([]);
    expect(rerun.skippedExisting).toBe(1);
  });

  it("reports no backend when neither standalone config nor host bridge exists", async () => {
    const backend = resolveCompletionBackend({ environment: {}, host: undefined });
    expect(backend.kind).toBe("unavailable");
  });
});
