import { describe, expect, it } from "vitest";
import {
  baseSignals,
  classifyEntry,
  contentPruneReason,
  createRemoteSourceIndex,
  defaultRemoteSourceDependencies,
  gitBlobSha,
  resolveRemoteSourceDependencies,
  scopePruneReason,
  textLineCount,
  normalizeSourcePath,
  type RemoteSourceBackend,
  type SourcePruningPolicy,
  type SourceScopeRoot,
  type SourceTreeApiEntry,
} from "../lib/remote-source-index";
import { SourceIndexError } from "../lib/remote-source-index";
import { candidatePriority, compareProfiles, createSlicePlanner, confidenceLabel, hasDotnetServicesProfile, hasFastapiProfile, hasLaravelProfile, hasRustServiceProfile, hasSpringJavaProfile, matchProfiles, reasonFor, toDiagnostic } from "../lib/slice-planner";
import type { SelectedSourceFile } from "../lib/slice-planner";

const revision = "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937";
const ref = { owner: "gzhanlei", repo: "commerce", revision };
const policy: SourcePruningPolicy = {
  excludedPrefixes: ["dist/", "vendor/", "third_party/"],
  excludedExtensions: [".png"],
  maxTrackedSourceBytes: 20,
};
const scopes: SourceScopeRoot[] = [{ path: "apps/checkout" }];

function file(name: string, signals: SelectedSourceFile["signals"] = ["manifest"]): SelectedSourceFile {
  return { path: name, blobSha: "blob", treeEntrySha: "tree", reason: "manifest", byteSize: 1, lineRanges: [{ startLine: 1, endLine: 1, purpose: "test" }], signals };
}

describe("remote source pure classification", () => {
  it("normalizes non-recursive tree paths and preserves recursive paths", () => {
    const relative = classifyEntry("apps/checkout", { path: "package.json", type: "blob", sha: "sha", size: 8 }, policy, scopes);
    expect(relative.path).toBe("apps/checkout/package.json");
    expect(relative.parentPath).toBe("apps/checkout");
    expect(relative.extension).toBe(".json");

    const recursive = classifyEntry("apps/checkout", { path: "apps/checkout/app/page.tsx", type: "blob", sha: "sha" }, policy, scopes);
    expect(recursive.path).toBe("apps/checkout/app/page.tsx");
    expect(recursive.signals).toEqual(["entrypoint", "service", "frontend"]);

    const directory = classifyEntry("", { path: "package.json", type: "tree", sha: "sha" }, policy, scopes);
    expect(directory.extension).toBe(".json");
    expect(directory.signals).toEqual([]);
    const extensionless = classifyEntry("", { path: "apps/checkout/extensionless", type: "blob", sha: "sha" }, policy, scopes);
    expect(extensionless.extension).toBeUndefined();
    expect(extensionless.signals).toEqual([]);
  });

  it("counts Git text lines without a phantom trailing line", () => {
    expect(textLineCount("one\ntwo\nthree\n")).toBe(3);
    expect(textLineCount("one\n\n")).toBe(2);
    expect(textLineCount("one")).toBe(1);
  });

  it("keeps exact prefix matching and distinguishes all prune reasons", () => {
    expect(classifyEntry("", { path: "vendor", type: "tree", sha: "sha" }, policy, scopes).pruned).toEqual({ reason: "third_party" });
    expect(classifyEntry("", { path: "vendorous", type: "tree", sha: "sha" }, policy, scopes).pruned).toEqual({ reason: "outside_product_scope" });
    expect(classifyEntry("", { path: "apps/checkout/generated/file.ts", type: "blob", sha: "sha", size: 1 }, policy, scopes).pruned).toEqual({ reason: "generated" });
    expect(classifyEntry("", { path: "apps/checkout/icon.png", type: "blob", sha: "sha", size: 1 }, policy, scopes).pruned).toEqual({ reason: "binary_asset" });
    expect(classifyEntry("", { path: "apps/checkout/huge.ts", type: "blob", sha: "sha", size: 21 }, policy, scopes).pruned).toEqual({ reason: "too_large" });
    expect(classifyEntry("", { path: "README.md", type: "blob", sha: "sha", size: 1 }, policy, scopes).pruned).toBeUndefined();
    expect(contentPruneReason("extensionless", { path: "extensionless", type: "blob", sha: "sha" }, policy)).toBeUndefined();
    expect(contentPruneReason("no-size.ts", { path: "no-size.ts", type: "blob", sha: "sha" }, policy, ".ts")).toBeUndefined();
  });

  it("distinguishes scoped ancestors, root manifests, and ordinary root files", () => {
    const manifest = { path: "README.md", type: "blob" as const, sha: "sha" };
    const ordinary = { path: "LICENSE", type: "blob" as const, sha: "sha" };
    expect(scopePruneReason("", "apps", { path: "apps", type: "tree", sha: "sha" }, scopes)).toBeUndefined();
    expect(scopePruneReason("", "apps/checkout", { ...manifest, path: "apps/checkout" }, scopes)).toBeUndefined();
    expect(scopePruneReason("", "README.md", manifest, scopes)).toBeUndefined();
    expect(scopePruneReason("", "LICENSE", ordinary, scopes)).toBe("outside_product_scope");
    expect(scopePruneReason("apps", "apps/checkout/src/server.ts", manifest, scopes)).toBeUndefined();
    expect(scopePruneReason("", "services", { path: "services", type: "tree", sha: "sha" }, [])).toBeUndefined();
    expect(baseSignals("app/page.tsx")).toEqual(["entrypoint", "service", "frontend"]);
    expect(baseSignals("database/migration.sql")).toEqual(["database", "migration"]);
    expect(baseSignals("worker.ts")).toEqual(["queue", "worker", "service"]);
  });
});

describe("planner pure decisions", () => {
  it("ranks priority candidates before ordinary source files", () => {
    const expected = [
      ["app/src/main/AndroidManifest.xml", 0],
      ["apps/checkout/package.json", 1],
      ["apps/checkout/app/page.tsx", 2],
      ["app/src/main/java/com/example/MainActivity.java", 3],
      ["uxplay/lib/raop.c", 4],
      ["apps/checkout/src/helper.ts", 5],
    ] as const;
    for (const [path, priority] of expected) {
      expect(candidatePriority({ ...file(path, ["entrypoint"]), parentPath: "", type: "blob", sha: "sha" })).toBe(priority);
    }
  });

  it("distinguishes profile confidence and stable profile identifiers", () => {
    const left = { profileId: "go-api" as const, confidence: 0.85, matchedSignals: [] };
    const right = { profileId: "next-web" as const, confidence: 0.9, matchedSignals: [] };
    const tieA = { ...left };
    const tieB = { ...left, profileId: "next-web" as const };
    expect(compareProfiles(right, left)).toBeLessThan(0);
    expect(compareProfiles(left, right)).toBeGreaterThan(0);
    expect(compareProfiles(tieA, tieB)).toBeLessThan(0);
  });

  it("maps every reason and confidence boundary", () => {
    expect(reasonFor(["manifest", "entrypoint", "route"])).toBe("manifest");
    expect(reasonFor(["entrypoint", "route"])).toBe("entrypoint");
    expect(reasonFor(["route", "database"])).toBe("route");
    expect(reasonFor(["database", "queue"])).toBe("database");
    expect(reasonFor(["queue", "auth"])).toBe("queue");
    expect(reasonFor(["auth", "deployment"])).toBe("auth");
    expect(reasonFor(["deployment", "frontend"])).toBe("deployment");
    expect(reasonFor(["frontend"])).toBe("service");
    expect(reasonFor(["native"])).toBe("service");
    expect(reasonFor([])).toBe("service");
    expect(reasonFor(["unknown" as "manifest"])).toBe("service");
    expect(confidenceLabel(0.72)).toBe("high");
    expect(confidenceLabel(0.719999)).toBe("medium");
    expect(confidenceLabel(0.5)).toBe("medium");
    expect(confidenceLabel(0.499999)).toBe("low");
  });

  it("normalizes the repository root to an empty path", () => {
    expect(normalizeSourcePath("")).toBe("");
    expect(normalizeSourcePath(".")).toBe("");
    expect(normalizeSourcePath("./apps/checkout")).toBe("apps/checkout");
  });

  it("allows every root child when scope is the repository root", () => {
    const rootScope = [{ path: "" }];
    expect(scopePruneReason("", "apps", { path: "apps", type: "tree", sha: "sha" }, rootScope)).toBeUndefined();
    expect(scopePruneReason("", "README.md", { path: "README.md", type: "blob", sha: "sha" }, rootScope)).toBeUndefined();
    expect(scopePruneReason("apps", "apps/checkout", { path: "apps/checkout", type: "tree", sha: "sha" }, rootScope)).toBeUndefined();
  });

  it("resolves explicit dependencies once and preserves default dependencies", () => {
    const now = () => new Date("2026-11-03T00:00:00.000Z");
    const filesystem = { async mkdir() {}, async writeFile() {} };
    expect(resolveRemoteSourceDependencies(undefined)).toEqual(defaultRemoteSourceDependencies);
    expect(resolveRemoteSourceDependencies({})).toEqual(defaultRemoteSourceDependencies);
    expect(resolveRemoteSourceDependencies({ filesystem, now })).toEqual({ filesystem, now });
    expect(resolveRemoteSourceDependencies({ now })).toEqual({ filesystem: defaultRemoteSourceDependencies.filesystem, now });
  });

  it("classifies a non-budget source index failure as failed planning", async () => {
    const sourceError = new (await import("../lib/remote-source-index")).SourceIndexError("github_request_failed", "GitHub unavailable");
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path): Promise<{ entries: SourceTreeApiEntry[]; truncated: boolean }> {
        const entries: SourceTreeApiEntry[] = path === "" ? [{ path: "apps", type: "tree", sha: "tree-apps" }] : path === "apps" ? [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }] : path === "apps/checkout" ? [
          { path: "apps/checkout/package.json", type: "blob", sha: gitBlobSha('{"dependencies":{"express":"1"}}'), size: 34 },
          { path: "apps/checkout/child", type: "tree", sha: "tree-child" },
        ] : [];
        if (path !== "apps/checkout/child") return { entries, truncated: false };
        throw sourceError;
      },
      async fetchBlob() {
        throw sourceError;
      },
    };
    const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend });
    const result = await createSlicePlanner({ now: () => 1 }).plan({
      product: { id: 1, slug: "checkout", name: "Checkout" },
      repository: ref,
      scopeRoots: [{ path: "apps/checkout" }],
      budgets: { maxSelectedFiles: 5, maxSelectedLineRanges: 5, maxPlannerContentBytes: 1000, maxAiContextSourceBytes: 1000, maxAiReadCalls: 1, maxComponents: 1, maxConnections: 1, maxRepairRounds: 1 },
      plannerVersion: "v1",
      profileVersion: "v1",
    }, index);
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toEqual({ code: "github_request_failed", message: "GitHub unavailable" });
  });

  it("matches Spring annotations case-insensitively", () => {
    const files = [{ path: "src/main/java/PetClinicApplication.java", blobSha: "sha", treeEntrySha: "sha", reason: "service" as const, byteSize: 100, lineRanges: [{ startLine: 1, endLine: 5, purpose: "service" }], signals: ["service" as const] }];
    const matches = matchProfiles(files, new Map([[files[0].path, "import org.springframework.boot.autoconfigure.SpringBootApplication;\n@SpringBootApplication\npublic class PetClinicApplication {}"]]));
    expect(matches.map((match) => match.profileId)).toContain("spring-java");
  });

  it("matches extended mainstream profiles", () => {
    const file = (path: string) => ({ path, blobSha: "sha", treeEntrySha: "sha", reason: "service" as const, byteSize: 1, lineRanges: [], signals: ["service" as const] });
    expect(hasSpringJavaProfile([file("pom.xml")], () => true)).toBe(true);
    expect(hasSpringJavaProfile([file("pom.xml")], () => false)).toBe(false);
    expect(hasSpringJavaProfile([file("src/App.java")], () => true)).toBe(true);
    expect(hasFastapiProfile([file("main.py")], () => true)).toBe(true);
    expect(hasFastapiProfile([file("main.go")], () => true)).toBe(false);
    expect(hasRustServiceProfile([file("Cargo.toml")])).toBe(true);
    expect(hasRustServiceProfile([file("src/main.rs")])).toBe(true);
    expect(hasLaravelProfile([file("composer.json")], () => true)).toBe(true);
    expect(hasLaravelProfile([file("composer.json")], () => false)).toBe(false);
    expect(hasDotnetServicesProfile([file("src/App.csproj"), file("src/Program.cs")])).toBe(true);
    expect(hasDotnetServicesProfile([file("src/App.csproj")])).toBe(false);
  });

  it("preserves source index diagnostics and maps ordinary failures", () => {
    expect(toDiagnostic(new Error("connection reset"))).toEqual({ code: "budget_exhausted", message: "connection reset" });
    expect(toDiagnostic("not an error")).toEqual({ code: "budget_exhausted", message: "slice planning failed" });
    const source = new SourceIndexError("blob_sha_mismatch", "sha mismatch");
    expect(toDiagnostic(source)).toEqual({ code: "blob_sha_mismatch", message: "sha mismatch" });
  });
});

describe("remote source runtime boundaries", () => {
  function backendWithBlob(content: string, raw?: Uint8Array, omitSize = false): RemoteSourceBackend {
    const sha = gitBlobSha(content);
    const trees = new Map<string, Array<SourceTreeApiEntry>>([
      ["", [{ path: "apps", type: "tree", sha: "tree-apps" }]],
      ["apps", [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }]],
      ["apps/checkout", [
        { path: "apps/checkout/file.txt", type: "blob", sha, ...(omitSize ? {} : { size: Buffer.byteLength(content) }) },
        { path: "apps/checkout/src", type: "tree", sha: "tree-src" },
      ]],
      ["apps/checkout/src", [{ path: "apps/checkout/src/server.ts", type: "blob", sha: gitBlobSha("line five\nline six\nline seven\nline eight\n"), size: 44 }]],
    ]);
    return {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        return { entries: trees.get(path) ?? [], truncated: false };
      },
      async fetchBlob(_source, path) {
        if (path === "apps/checkout/file.txt") return raw ?? new TextEncoder().encode(content);
        return new TextEncoder().encode("line five\nline six\nline seven\nline eight\n");
      },
    };
  }

  it("keeps line numbers valid for empty source files", async () => {
    const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend: backendWithBlob("") });
    const read = await index.readLines({ path: "apps/checkout/file.txt", startLine: 1, endLine: 1, requestedBy: "planner", reason: "empty file" });
    expect(read.startLine).toBe(1);
    expect(read.endLine).toBeGreaterThanOrEqual(read.startLine);
  });

  it("reports null metadata for directories, pruned files, and absent entries", async () => {
    const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend: backendWithBlob("{}\n") });
    await index.listDir("apps/checkout");
    expect(await index.statPath("apps/checkout/src")).toBeNull();
    expect(await index.statPath("apps/checkout/file.bin")).toBeNull();
    expect(await index.statPath("apps/checkout/missing.ts")).toBeNull();
  });

  it("enforces exact blob byte boundaries and reads blobs without Git sizes", async () => {
    const content = "12345";
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path): Promise<{ entries: SourceTreeApiEntry[]; truncated: boolean }> {
        const entries: SourceTreeApiEntry[] = path === "" ? [{ path: "apps", type: "tree", sha: "tree-apps" }] : path === "apps" ? [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }] : path === "apps/checkout" ? [
          { path: "apps/checkout/exact.txt", type: "blob", sha: gitBlobSha(content), size: 5 },
          { path: "apps/checkout/oversized.txt", type: "blob", sha: gitBlobSha(content), size: 6 },
          { path: "apps/checkout/no-size.txt", type: "blob", sha: gitBlobSha(content) },
        ] : [];
        return { entries, truncated: false };
      },
      async fetchBlob(_source, path) {
        return new TextEncoder().encode(content);
      },
    };
    const exact = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend, budgets: { maxBlobBytes: 5 } });
    await expect(exact.readLines({ path: "apps/checkout/exact.txt", startLine: 1, endLine: 1, requestedBy: "planner", reason: "exact" })).resolves.toMatchObject({ lines: ["12345"] });
    const oversized = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend, budgets: { maxBlobBytes: 5 } });
    await expect(oversized.readLines({ path: "apps/checkout/oversized.txt", startLine: 1, endLine: 1, requestedBy: "planner", reason: "oversized" })).rejects.toThrow("source blob exceeds max bytes");
    const noSize = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend, budgets: { maxBlobBytes: 0 } });
    await expect(noSize.readLines({ path: "apps/checkout/no-size.txt", startLine: 1, endLine: 1, requestedBy: "planner", reason: "unknown size is allowed" })).resolves.toMatchObject({ lines: ["12345"] });
  });

  it("reports cache metadata when Git omitted blob size and clamps reads by budget", async () => {
    const index = await createRemoteSourceIndex(ref, {
      access: {},
      scopeRoots: scopes,
      backend: backendWithBlob("line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\n", undefined, true),
      budgets: { maxLinesPerRead: 3 },
    });
    const before = await index.statPath("apps/checkout/file.txt");
    expect(before).toEqual({
      path: "apps/checkout/file.txt",
      blobSha: gitBlobSha("line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\n"),
      treeEntrySha: gitBlobSha("line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\n"),
      byteSize: 0,
      lineCount: undefined,
      cacheState: "miss",
    });
    const read = await index.readLines({ path: "apps/checkout/file.txt", startLine: 5, endLine: 99, requestedBy: "planner", reason: "clamp" });
    expect(read).toMatchObject({ startLine: 5, endLine: 7, lines: ["line five", "line six", "line seven"], cacheState: "fetched" });
    const after = await index.statPath("apps/checkout/file.txt");
    expect(after).toMatchObject({ byteSize: Buffer.byteLength("line one\nline two\nline three\nline four\nline five\nline six\nline seven\nline eight\n"), lineCount: 8, cacheState: "cached" });
  });

  it("allows an exact content budget but rejects one additional selected byte", async () => {
    const content = "one\ntwo\n";
    const bytes = new TextEncoder().encode(content);
    const fullBudget = bytes.byteLength + Buffer.byteLength("one\ntwo");
    const exact = await createRemoteSourceIndex(ref, {
      access: {},
      scopeRoots: scopes,
      backend: backendWithBlob(content),
      budgets: { maxTotalContentBytes: fullBudget, maxBlobBytes: 1_000 },
    });
    await exact.readLines({ path: "apps/checkout/file.txt", startLine: 1, endLine: 2, requestedBy: "planner", reason: "exact" });

    const oneByteShort = await createRemoteSourceIndex(ref, {
      access: {},
      scopeRoots: scopes,
      backend: backendWithBlob(content),
      budgets: { maxTotalContentBytes: fullBudget - 1, maxBlobBytes: 1_000 },
    });
    await expect(oneByteShort.readLines({ path: "apps/checkout/file.txt", startLine: 1, endLine: 2, requestedBy: "planner", reason: "short" })).rejects.toThrow("remote source content budget was exhausted");
  });

  it("rejects non-UTF-8 content that was not pruned by extension", async () => {
    const invalid = new Uint8Array([0xf0, 0x9f]);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        if (!path) return { entries: [{ path: "apps", type: "tree", sha: "tree-apps" }], truncated: false };
        if (path === "apps") return { entries: [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }], truncated: false };
        return { entries: [{ path: "apps/checkout/file.dat", type: "blob", sha: gitBlobSha(invalid), size: invalid.byteLength }], truncated: false };
      },
      async fetchBlob() {
        return invalid;
      },
    };
    const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: scopes, backend });
    await expect(index.readLines({ path: "apps/checkout/file.dat", startLine: 1, endLine: 1, requestedBy: "planner", reason: "invalid" })).rejects.toThrow("not valid UTF-8");
  });
});
