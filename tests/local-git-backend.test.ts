import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalGitBackend } from "../lib/remote-source-index/local-git-backend";
import type { SourceRevisionRef } from "../lib/remote-source-index/types";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function makeTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "local-git-backend-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  run(["init", "-q"]);
  run(["config", "user.email", "bench@test"]);
  run(["config", "user.name", "bench"]);
  mkdirSync(path.join(dir, "src"));
  writeFileSync(path.join(dir, "src", "demo.ts"), "export function demo() {\n  return 1;\n}\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "initial"]);
  return dir;
}

describe("local git source backend", () => {
  it("resolves revisions, lists trees recursively and fetches blobs", async () => {
    const repoDir = makeTempRepo();
    const revision = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"]).toString().trim();
    const backend = createLocalGitBackend({ repoDir });

    const { rootTreeSha } = await backend.resolveRevision({ owner: "local", repo: "bench", revision } as SourceRevisionRef);
    expect(rootTreeSha).toMatch(/^[0-9a-f]{40}$/);

    const ref = { owner: "local", repo: "bench", revision };
    const whole = await backend.listWholeTree!(ref as SourceRevisionRef, rootTreeSha);
    expect(whole.truncated).toBe(false);
    const demoEntry = whole.entries.find((entry) => entry.path === "src/demo.ts")!;
    expect(demoEntry.type).toBe("blob");
    expect(demoEntry.size).toBeGreaterThan(0);

    const scoped = await backend.listTree(ref as SourceRevisionRef, rootTreeSha, "src");
    expect(scoped.entries.some((entry) => entry.path === "demo.ts")).toBe(true);

    const blob = await backend.fetchBlob(ref as SourceRevisionRef, "src/demo.ts", demoEntry.sha);
    expect(new TextDecoder().decode(blob)).toContain("return 1");
  });

  it("reports a missing revision as an error instead of guessing", async () => {
    const repoDir = makeTempRepo();
    const backend = createLocalGitBackend({ repoDir });
    await expect(
      backend.resolveRevision({ owner: "local", repo: "bench", revision: "deadbeef".repeat(8) } as SourceRevisionRef),
    ).rejects.toThrow();
  });
});
