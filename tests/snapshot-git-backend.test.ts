import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteSourceIndex, type SourceTreeApiEntry } from "../lib/remote-source-index";
import { createLocalGitBackend, resolveGitSnapshot } from "../lib/snapshot/git-backend";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(root: string, ...args: string[]) {
  return exec("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-snapshot-git-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "snapshot@example.test");
  await git(root, "config", "user.name", "Snapshot Test");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "snapshot-fixture", version: "1.0.0" }));
  await writeFile(join(root, "src", "index.ts"), "export const version = 1;\n");
  await writeFile(join(root, "root.ts"), "export const outsideScope = true;\n");
  await writeFile(join(root, "src", "中文 file.ts"), "export const label = \"原始\";\n");
  await writeFile(join(root, "src", "line\nbreak.ts"), "export const newlinePath = true;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial snapshot");
  return root;
}

async function head(root: string) {
  return (await git(root, "rev-parse", "HEAD")).stdout.trim();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local git snapshot backend", () => {
  it("resolves HEAD metadata and reads committed source through the existing index", async () => {
    const root = await repository();
    const snapshot = await resolveGitSnapshot(root);
    expect(snapshot.revision).toBe(await head(root));
    expect(snapshot.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.message).toBe("initial snapshot");
    expect(snapshot.workingTreeDirty).toBe(false);

    const backend = createLocalGitBackend(snapshot);
    expect(backend.kind).toBe("local_git");
    const index = await createRemoteSourceIndex(
      { owner: "local", repo: basename(root), revision: snapshot.revision },
      { access: {}, scopeRoots: [], backend },
    );
    const source = await index.readLines({ path: "src/index.ts", startLine: 1, endLine: 5, requestedBy: "evidence_verifier", reason: "test" });
    expect(source.lines).toEqual(["export const version = 1;"]);
    expect(source.verified).toBe(true);
    expect(index.identity.rootTreeSha).toBe(snapshot.treeSha);
  });

  it("lists NUL-delimited unicode, spaces and newline paths without corrupting them", async () => {
    const root = await repository();
    const snapshot = await resolveGitSnapshot(root);
    const backend = createLocalGitBackend(snapshot);
    const resolved = await backend.resolveRevision({ owner: "local", repo: "fixture" });
    const tree = await backend.listWholeTree!({ owner: "local", repo: "fixture", revision: snapshot.revision }, resolved.rootTreeSha);
    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["src/中文 file.ts", "src/line\nbreak.ts"]));
    for (const entry of tree.entries) {
      expect(entry.sha).toMatch(/^[0-9a-f]{40}$/);
      if (entry.type === "blob") expect(entry.size).toBeGreaterThan(0);
    }
  });

  it("reads an explicit historical ref and never mixes dirty working-tree content", async () => {
    const root = await repository();
    const first = await head(root);
    await writeFile(join(root, "src", "index.ts"), "export const version = 2;\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "second snapshot");
    await writeFile(join(root, "src", "index.ts"), "export const version = 999;\n");
    await writeFile(join(root, "untracked.ts"), "export const untracked = true;\n");

    const snapshot = await resolveGitSnapshot(root, first);
    expect(snapshot.workingTreeDirty).toBe(true);
    const index = await createRemoteSourceIndex(
      { owner: "local", repo: "fixture", revision: first },
      { access: {}, scopeRoots: [], backend: createLocalGitBackend(snapshot) },
    );
    const source = await index.readLines({ path: "src/index.ts", startLine: 1, endLine: 1, requestedBy: "evidence_verifier", reason: "test" });
    expect(source.lines).toEqual(["export const version = 1;"]);
    expect(await index.statPath("untracked.ts")).toBeNull();
    expect(await readFile(join(root, "src", "index.ts"), "utf8")).toContain("999");
  });

  it("rejects invalid repositories and revisions without invoking shell interpretation", async () => {
    const root = await repository();
    await expect(resolveGitSnapshot(root, "--help")).rejects.toThrow();
    await expect(resolveGitSnapshot(join(root, "missing"))).rejects.toThrow();
    const empty = await mkdtemp(join(tmpdir(), "codelphi-snapshot-empty-"));
    roots.push(empty);
    await git(empty, "init");
    await expect(resolveGitSnapshot(empty)).rejects.toThrow();
  });

  it("keeps scope and blob budgets enforced by RemoteSourceIndex", async () => {
    const root = await repository();
    const snapshot = await resolveGitSnapshot(root);
    const backend = createLocalGitBackend(snapshot);
    const scoped = await createRemoteSourceIndex(
      { owner: "local", repo: "fixture", revision: snapshot.revision },
      { access: {}, scopeRoots: [{ path: "src" }], backend },
    );
    await expect(scoped.readLines({ path: "root.ts", startLine: 1, endLine: 1, requestedBy: "planner", reason: "outside scope" })).rejects.toThrow(/outside product scope|pruned/);

    const bounded = await createRemoteSourceIndex(
      { owner: "local", repo: "fixture", revision: snapshot.revision },
      { access: {}, scopeRoots: [], backend, budgets: { maxBlobBytes: 1 } },
    );
    await expect(bounded.readLines({ path: "src/index.ts", startLine: 1, endLine: 1, requestedBy: "planner", reason: "budget" })).rejects.toThrow(/exceeds max bytes/);
  });

  it("retains the existing blob integrity check when a backend returns the wrong bytes", async () => {
    const root = await repository();
    const snapshot = await resolveGitSnapshot(root);
    const backend = createLocalGitBackend(snapshot);
    const originalList = backend.listWholeTree!;
    const wrongSha = "0".repeat(40);
    backend.listWholeTree = async (ref, treeSha) => {
      const result = await originalList(ref, treeSha);
      return {
        ...result,
        entries: result.entries.map((entry): SourceTreeApiEntry => entry.path === "src/index.ts" ? { ...entry, sha: wrongSha } : entry),
      };
    };
    backend.fetchBlob = async () => new TextEncoder().encode("not the requested blob");
    const index = await createRemoteSourceIndex(
      { owner: "local", repo: "fixture", revision: snapshot.revision },
      { access: {}, scopeRoots: [], backend },
    );
    await expect(index.readLines({ path: "src/index.ts", startLine: 1, endLine: 1, requestedBy: "planner", reason: "integrity" })).rejects.toThrow(/blob SHA mismatch/);
  });
});
