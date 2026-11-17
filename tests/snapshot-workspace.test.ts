import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeSnapshotWorkspace, prepareSnapshotWorkspace, writeSnapshotResult } from "../lib/snapshot/workspace";
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
});
