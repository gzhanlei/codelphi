import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPullRequestFiles, listIssueComments, upsertIssueComment } from "../lib/github";

const repo = { owner: "gzhanlei", name: "radar", defaultBranch: "main" };

describe("GitHub PR API helpers", () => {
  beforeEach(() => vi.stubEnv("GITHUB_TOKEN", "test-token"));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fetches PR files and normalizes missing patches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { filename: "lib/analysis.ts", status: "modified", patch: "@@ -1 +1 @@" },
      { filename: "assets/logo.png", status: "added" },
    ]), { status: 200 })));
    const files = await getPullRequestFiles(repo, 7);
    expect(files).toEqual([
      { path: "lib/analysis.ts", status: "modified", patch: "@@ -1 +1 @@" },
      { path: "assets/logo.png", status: "added", patch: "" },
    ]);
  });

  it("paginates until a short page arrives", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified" }));
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(calls.length === 1 ? page : []), { status: 200 });
    }));
    expect(await getPullRequestFiles(repo, 7)).toHaveLength(100);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("pulls/7/files?page=1");
    expect(calls[1]).toContain("pulls/7/files?page=2");
  });

  it("creates a comment when no comment id is given", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 42 }), { status: 201 });
    }));
    expect(await upsertIssueComment(repo, 7, "hello", null)).toBe(42);
    expect(calls[0].url).toContain("/issues/7/comments");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ body: "hello" });
  });

  it("patches the existing comment when an id is given", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    }));
    expect(await upsertIssueComment(repo, 7, "updated", 42)).toBe(42);
    expect(calls[0].url).toContain("/issues/comments/42");
    expect(calls[0].init.method).toBe("PATCH");
  });

  it("lists issue comments with id and body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { id: 1, body: "<!-- radar-pr-preview -->preview" },
      { id: 2, body: "other" },
    ]), { status: 200 })));
    expect(await listIssueComments(repo, 7)).toEqual([
      { id: 1, body: "<!-- radar-pr-preview -->preview" },
      { id: 2, body: "other" },
    ]);
  });
});
