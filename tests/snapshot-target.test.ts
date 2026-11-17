import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGitHubRepository, resolveSnapshotTarget } from "../lib/snapshot/target";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(root: string, ...args: string[]) {
  return exec("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function repository(root?: string) {
  const repo = root ?? await mkdtemp(join(tmpdir(), "codelphi-target-local-"));
  if (!root) roots.push(repo);
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "snapshot@example.test");
  await git(repo, "config", "user.name", "Snapshot Test");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
  await writeFile(join(repo, "src", "index.ts"), "export const feature = true;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "initial");
  return repo;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("snapshot target resolution", () => {
  it("accepts only canonical public GitHub repository URLs", () => {
    expect(parseGitHubRepository("https://github.com/owner/repo")).toEqual({ owner: "owner", name: "repo", url: "https://github.com/owner/repo" });
    expect(parseGitHubRepository("https://github.com/owner/repo.git/")).toEqual({ owner: "owner", name: "repo", url: "https://github.com/owner/repo" });
    for (const invalid of [
      "http://github.com/owner/repo",
      "https://gitlab.com/owner/repo",
      "https://github.com/owner/repo/tree/main",
      "https://user:secret@github.com/owner/repo",
      "https://github.com/owner/repo?tab=readme",
      "https://github.com/owner/repo#readme",
      "git@github.com:owner/repo.git",
    ]) expect(() => parseGitHubRepository(invalid)).toThrow();
  });

  it("resolves a local repository without writing to it", async () => {
    const root = await repository();
    const target = await resolveSnapshotTarget(root);
    expect(target.identity.source).toBe("local");
    expect(target.identity.name).not.toBe("");
    expect(target.identity.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(target.backend.kind).toBe("local_git");
    await target.cleanup();
    expect(await readFileSafe(join(root, "src", "index.ts"))).toBe("export const feature = true;\n");
  });

  it("clones a public target into a temporary directory and always cleans it up", async () => {
    let clonedRoot = "";
    const clone = vi.fn(async (_url: string, destination: string) => {
      clonedRoot = destination;
      await repository(destination);
    });
    const target = await resolveSnapshotTarget("https://github.com/owner/repo", undefined, { clone });
    expect(target.identity).toMatchObject({ source: "github", owner: "owner", name: "repo", repositoryUrl: "https://github.com/owner/repo" });
    expect(clone).toHaveBeenCalledOnce();
    await target.cleanup();
    await expect(access(clonedRoot)).rejects.toThrow();
  });

  it("cleans a temporary clone when snapshot resolution fails", async () => {
    let clonedRoot = "";
    const clone = vi.fn(async (_url: string, destination: string) => {
      clonedRoot = destination;
      await mkdir(destination, { recursive: true });
    });
    await expect(resolveSnapshotTarget("https://github.com/owner/repo", undefined, { clone })).rejects.toThrow();
    await expect(access(clonedRoot)).rejects.toThrow();
  });
});

async function readFileSafe(path: string) {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
