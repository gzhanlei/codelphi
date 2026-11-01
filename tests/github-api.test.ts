import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChangeContext, getSourceSnapshot } from "../lib/github";

const repo = { owner: "gzhanlei", name: "radar", defaultBranch: "main" };

describe("GitHub API workflows", () => {
  beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "test-token"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("loads compare and initial-commit contexts through the API", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("/compare/")) {
        return new Response(JSON.stringify({ html_url: "https://github.com/compare", commits: [{ sha: "b", commit: { message: "feat: change", committer: { date: "2026-11-01" } } }], files: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ html_url: "https://github.com/commit", commit: { message: "feat: initial", committer: { date: "2026-11-01" } }, files: [] }), { status: 200 });
    }));
    expect((await getChangeContext(repo, "a", "b")).message).toBe("feat: change");
    expect((await getChangeContext(repo, null, "b")).message).toBe("feat: initial");
    expect(urls[0]).toContain("/compare/a...b");
    expect(urls[1]).toContain("/commits/b");
  });

  it("collects supported source files and skips unsupported content", async () => {
    const encoded = Buffer.from("const answer = 42;", "utf8").toString("base64");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/git/trees/")) {
        return new Response(JSON.stringify({ tree: [
          { path: "README.md", type: "blob", size: 30 },
          { path: "unsupported.ts", type: "blob", size: 30 },
        ] }), { status: 200 });
      }
      if (url.includes("README.md")) return new Response(JSON.stringify({ encoding: "base64", content: encoded }), { status: 200 });
      return new Response(JSON.stringify({ encoding: "utf8", content: encoded }), { status: 200 });
    }));
    const sources = await getSourceSnapshot(repo, "sha");
    expect(sources).toEqual([{ path: "README.md", content: "1: const answer = 42;" }]);
  });
});
