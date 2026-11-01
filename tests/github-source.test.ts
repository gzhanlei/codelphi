import { describe, expect, it } from "vitest";
import { normalizeChangeContext, numberedSourceContent, selectSourceCandidates } from "../lib/github-source";

describe("GitHub source boundaries", () => {
  it("normalizes compare responses into release context", () => {
    const result = normalizeChangeContext({
      html_url: "https://github.com/gzhanlei/radar/compare/a...b",
      commits: [{ sha: "b", commit: { message: "feat: add specs", committer: { date: "2026-11-01T00:00:00Z" } } }],
      files: [{ filename: "lib/spec.ts", status: "modified", patch: "@@ -1 +1 @@" }],
    }, "b");
    expect(result.message).toBe("feat: add specs");
    expect(result.committedAt).toBe("2026-11-01T00:00:00Z");
    expect(result.files).toEqual([{ path: "lib/spec.ts", status: "modified", patch: "@@ -1 +1 @@" }]);
  });

  it("normalizes a single initial commit and tolerates missing patches", () => {
    const result = normalizeChangeContext({
      html_url: "https://github.com/gzhanlei/radar/commit/b",
      commit: { message: "chore: initial", committer: { date: "2026-11-01T01:00:00Z" } },
      files: [{ filename: "image.png", status: "added" }],
    }, "b");
    expect(result.message).toBe("chore: initial");
    expect(result.files[0].patch).toBe("(binary or patch unavailable)");
  });

  it("uses the newest commit, falls back from an empty commit list, and tolerates missing dates", () => {
    const result = normalizeChangeContext({
      commits: [
        { sha: "a", commit: { message: "older" } },
        { sha: "b", commit: { message: "newest" } },
      ],
    }, "b");
    expect(result.message).toBe("newest");
    expect(result.committedAt).toEqual(expect.any(String));
    expect(normalizeChangeContext({ commit: { message: "" } }, "b").message).toBe("");
    expect(normalizeChangeContext({ commit: { message: "empty date", committer: { date: "" } } }, "b").committedAt).toBe("");
    expect(normalizeChangeContext({ commits: [], commit: { message: "fallback" } }, "b").message).toBe("fallback");
    expect(normalizeChangeContext({ files: [{ filename: "empty.ts", status: "modified", patch: "" }] }, "b").files[0].patch).toBe("");
    expect(normalizeChangeContext({ html_url: "", commit: { message: "empty url" } }, "b", "fallback-url").url).toBe("");
  });

  it("falls back to the short SHA and supplied commit URL when commit metadata is absent", () => {
    const result = normalizeChangeContext({}, "abcdef123456", "https://github.com/gzhanlei/radar/commit/abcdef123456");
    expect(result.message).toBe("Release abcdef1");
    expect(result.url).toBe("https://github.com/gzhanlei/radar/commit/abcdef123456");
    expect(result.files).toEqual([]);
  });

  it("selects small readable source files in documentation-first order", () => {
    const candidates = selectSourceCandidates({ tree: [
      { path: "node_modules/pkg/index.ts", type: "blob", size: 20 },
      { path: "app/page.tsx", type: "blob", size: 20 },
      { path: "README.md", type: "blob", size: 20 },
      { path: "package-lock.json", type: "blob", size: 20 },
      { path: "lib/oauth.ts", type: "blob", size: 20 },
      { path: "huge.ts", type: "blob", size: 100_000 },
    ] });
    expect(candidates.map((entry) => entry.path)).toEqual(["README.md", "app/page.tsx", "lib/oauth.ts"]);
  });

  it("includes unknown file sizes, respects size limits and caps the candidate count", () => {
    const candidates = selectSourceCandidates({ tree: [
      { path: "unknown-size.ts", type: "blob" },
      { path: "empty.ts", type: "blob", size: 0 },
      { path: "at-limit.ts", type: "blob", size: 80_000 },
      { path: "too-big.ts", type: "blob", size: 80_001 },
    ] });
    expect(candidates.map((entry) => entry.path)).toContain("unknown-size.ts");
    expect(candidates.map((entry) => entry.path)).toContain("empty.ts");
    expect(candidates.map((entry) => entry.path)).toContain("at-limit.ts");
    expect(candidates.map((entry) => entry.path)).not.toContain("too-big.ts");
    const capped = selectSourceCandidates({ tree: Array.from({ length: 30 }, (_, index) => ({ path: `app/file-${index}.ts`, type: "blob", size: 100 })) });
    expect(capped).toHaveLength(28);
    expect(capped[0].path).toBe("app/file-0.ts");
  });

  it("decodes source and adds stable line numbers", () => {
    const encoded = Buffer.from("first\nsecond", "utf8").toString("base64");
    expect(numberedSourceContent({ encoding: "base64", content: encoded }, 100)).toBe("1: first\n2: second");
    expect(numberedSourceContent({ encoding: "base64", content: encoded }, 7)).toBe("1: firs");
    expect(numberedSourceContent({ encoding: "utf8", content: encoded }, 100)).toBeNull();
  });
});
