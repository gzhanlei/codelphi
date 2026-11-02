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
    const capped = selectSourceCandidates({ tree: Array.from({ length: 60 }, (_, index) => ({ path: `app/file-${String(index).padStart(2, "0")}.ts`, type: "blob", size: 100 })) });
    expect(capped).toHaveLength(48);
    expect(capped[0].path).toBe("app/file-00.ts");
    expect(capped[1].path).toBe("app/file-59.ts");
  });

  it("balances source directories before taking more files from app", () => {
    const candidates = selectSourceCandidates({ tree: [
      ...Array.from({ length: 8 }, (_, index) => ({ path: `app/file-${index}.ts`, type: "blob", size: 100 })),
      { path: "components/tree.tsx", type: "blob", size: 100 },
      { path: "lib/spec.ts", type: "blob", size: 100 },
      { path: "migrations/001.sql", type: "blob", size: 100 },
    ] });
    expect(candidates.slice(0, 4).map((entry) => entry.path)).toEqual(["app/file-0.ts", "components/tree.tsx", "lib/spec.ts", "migrations/001.sql"]);
  });

  it("sorts within each group and interleaves small groups without dropping entries", () => {
    const tiny = selectSourceCandidates({ tree: [
      { path: "app/file-2.ts", type: "blob", size: 100 },
      { path: "app/file-0.ts", type: "blob", size: 100 },
      { path: "app/file-1.ts", type: "blob", size: 100 },
    ] });
    expect(tiny.map((entry) => entry.path)).toEqual(["app/file-0.ts", "app/file-2.ts", "app/file-1.ts"]);
    const docs = selectSourceCandidates({ tree: [
      { path: "docs/guide.ts", type: "blob", size: 100 },
      { path: "docs/README.md", type: "blob", size: 100 },
    ] });
    expect(docs.map((entry) => entry.path)).toEqual(["docs/README.md", "docs/guide.ts"]);
  });

  it("prioritizes Android application sources over vendored files", () => {
    const candidates = selectSourceCandidates({ tree: [
      { path: "deps/libplist/README.md", type: "blob", size: 20_000 },
      { path: "deps/libplist/src/base64.c", type: "blob", size: 20_000 },
      { path: ".github/workflows/build.yml", type: "blob", size: 20_000 },
      { path: "uxplay/lib/raop.c", type: "blob", size: 60_000 },
      { path: "app/src/main/AndroidManifest.xml", type: "blob", size: 4_000 },
      { path: "app/src/main/java/com/codelphi/airplay/MirrorActivity.java", type: "blob", size: 10_000 },
      { path: "app/src/main/java/com/codelphi/airplay/AirPlayService.java", type: "blob", size: 12_000 },
      { path: "app/src/main/cpp/airplay_jni.c", type: "blob", size: 14_000 },
      { path: "web/middleware.ts", type: "blob", size: 1_000 },
    ] });
    const paths = candidates.map((entry) => entry.path);
    expect(paths.indexOf("app/src/main/AndroidManifest.xml")).toBeLessThan(paths.indexOf("app/src/main/java/com/codelphi/airplay/AirPlayService.java"));
    expect(paths.indexOf("app/src/main/java/com/codelphi/airplay/AirPlayService.java")).toBeLessThan(paths.indexOf("app/src/main/java/com/codelphi/airplay/MirrorActivity.java"));
    expect(paths.indexOf("app/src/main/java/com/codelphi/airplay/MirrorActivity.java")).toBeLessThan(paths.indexOf("app/src/main/cpp/airplay_jni.c"));
    expect(paths.indexOf("app/src/main/cpp/airplay_jni.c")).toBeLessThan(paths.indexOf("uxplay/lib/raop.c"));
    expect(paths.indexOf("uxplay/lib/raop.c")).toBeLessThan(paths.indexOf("web/middleware.ts"));
    expect(paths).not.toContain("deps/libplist/README.md");
    expect(paths).not.toContain("deps/libplist/src/base64.c");
    expect(paths).not.toContain(".github/workflows/build.yml");
  });

  it("prioritizes OAuth and database entry points before other internal modules", () => {
    const candidates = selectSourceCandidates({ tree: [
      { path: "internal/wallet/service.go", type: "blob", size: 100 },
      { path: "internal/oauth/service.go", type: "blob", size: 100 },
      { path: "internal/db/db.go", type: "blob", size: 100 },
      { path: "web/middleware.ts", type: "blob", size: 100 },
      { path: "web/app/page.tsx", type: "blob", size: 100 },
    ] });
    expect(candidates[0].path).toBe("web/app/page.tsx");
    expect(candidates.slice(1, 3).map((entry) => entry.path)).toEqual(["internal/db/db.go", "internal/oauth/service.go"]);
    expect(candidates.map((entry) => entry.path)).toContain("web/app/page.tsx");
    expect(candidates.map((entry) => entry.path)).toContain("web/middleware.ts");
  });

  it("keeps metadata and group priority ahead of lexical ordering", () => {
    const candidates = selectSourceCandidates({ tree: [
      { path: "lib/z.ts", type: "blob", size: 20 },
      { path: "app/z.ts", type: "blob", size: 20 },
      { path: "README.md", type: "blob", size: 20 },
      { path: "lib/a.ts", type: "blob", size: 20 },
      { path: "app/a.ts", type: "blob", size: 20 },
    ] });
    const paths = candidates.map((entry) => entry.path);
    expect(paths.indexOf("README.md")).toBeLessThan(paths.indexOf("app/a.ts"));
    expect(paths.indexOf("app/a.ts")).toBeLessThan(paths.indexOf("lib/a.ts"));
    expect(paths.indexOf("app/a.ts")).toBeLessThan(paths.indexOf("app/z.ts"));
  });

  it("decodes source and adds stable line numbers", () => {
    const encoded = Buffer.from("first\nsecond", "utf8").toString("base64");
    expect(numberedSourceContent({ encoding: "base64", content: encoded }, 100)).toBe("1: first\n2: second");
    expect(numberedSourceContent({ encoding: "base64", content: encoded }, 7)).toBe("1: firs");
    expect(numberedSourceContent({ encoding: "utf8", content: encoded }, 100)).toBeNull();
  });
});
