import { describe, expect, it } from "vitest";
import { baseSignals, contentPruneReason, createRemoteSourceIndex, dependencyPruneReason, gitBlobSha, scopePruneReason, type RemoteSourceBackend } from "../lib/remote-source-index";

const revision = "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937";

function blob(content: string) {
  return gitBlobSha(content);
}

function createBackend() {
  const files = new Map([
    ["README.md", "checkout platform\n"],
    ["apps/checkout/package.json", JSON.stringify({ name: "checkout-web", dependencies: { next: "16.0.0" } })],
    ["apps/checkout/src/server.ts", "export function start() {\n  return \"checkout\";\n}\n"],
    ["third_party/sdk/index.ts", "export const sdk = true;\n"],
  ]);
  const trees = new Map<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>([
    ["", [
      { path: "apps", type: "tree", sha: "tree-apps" },
      { path: "README.md", type: "blob", sha: blob("checkout platform\n"), size: 18 },
      { path: "third_party", type: "tree", sha: "tree-third_party" },
    ]],
    ["apps", [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }]],
    ["apps/checkout", [
      { path: "apps/checkout/package.json", type: "blob", sha: blob(files.get("apps/checkout/package.json")!), size: 54 },
      { path: "apps/checkout/src", type: "tree", sha: "tree-src" },
    ]],
    ["apps/checkout/src", [
      { path: "apps/checkout/src/server.ts", type: "blob", sha: blob(files.get("apps/checkout/src/server.ts")!), size: 45 },
    ]],
    ["third_party", [{ path: "third_party/sdk", type: "tree", sha: "tree-sdk" }]],
  ]);
  const calls = { trees: 0, blobs: 0 };

  const backend: RemoteSourceBackend = {
    kind: "github_api",
    async resolveRevision() {
      return { rootTreeSha: "tree-root" };
    },
    async listTree(_source, treeSha, path) {
      calls.trees += 1;
      const entries = trees.get(path) ?? [];
      if (entries.length === 0 || path === "third_party/sdk") throw new Error(`unexpected tree path ${path}`);
      return { entries, truncated: false };
    },
    async fetchBlob(_source, path, _blobSha) {
      calls.blobs += 1;
      const content = files.get(path);
      if (!content) throw new Error(`unexpected blob path ${path}`);
      return new TextEncoder().encode(content);
    },
  };
  return { backend, calls, files };
}

describe("remote source classification", () => {
  it("maps dependency prefixes to exact prune reasons", () => {
    expect(dependencyPruneReason("third_party")).toBe("third_party");
    expect(dependencyPruneReason("third_party/sdk")).toBe("third_party");
    expect(dependencyPruneReason("vendor")).toBe("third_party");
    expect(dependencyPruneReason("vendor/lib")).toBe("third_party");
    expect(dependencyPruneReason("node_modules")).toBe("dependency_directory");
    expect(dependencyPruneReason("node_modules/pkg")).toBe("dependency_directory");
    expect(dependencyPruneReason("dist")).toBe("build_output");
    expect(dependencyPruneReason("build/app")).toBe("build_output");
  });

  it("maps content signals and size limits to prune reasons", () => {
    const raw = { path: "app/thing.ts", type: "blob" as const, sha: "sha" };
    const policy = { excludedPrefixes: [], excludedExtensions: [".png"], maxTrackedSourceBytes: 10 };
    expect(contentPruneReason("generated/thing.ts", raw, policy)).toBe("generated");
    expect(contentPruneReason("a/__generated__/thing.ts", raw, policy)).toBe("generated");
    expect(contentPruneReason("icon.png", { ...raw, path: "icon.png" }, policy, ".png")).toBe("binary_asset");
    expect(contentPruneReason("huge.ts", { ...raw, path: "huge.ts", size: 11 }, policy, ".ts")).toBe("too_large");
    expect(contentPruneReason("just-enough.ts", { ...raw, path: "just-enough.ts", size: 10 }, policy, ".ts")).toBeUndefined();
    expect(contentPruneReason("tree", { path: "tree", type: "tree", sha: "sha" }, policy)).toBeUndefined();
  });

  it("keeps scope roots, ancestors, and root manifests while pruning other root entries", () => {
    const raw = { path: "README.md", type: "blob" as const, sha: "sha" };
    const scopes = [{ path: "apps/checkout" }];
    expect(scopePruneReason("", "apps", { path: "apps", type: "tree", sha: "sha" }, scopes)).toBeUndefined();
    expect(scopePruneReason("", "apps/checkout", { ...raw, path: "apps/checkout" }, scopes)).toBeUndefined();
    expect(scopePruneReason("", "README.md", raw, scopes)).toBeUndefined();
    expect(scopePruneReason("", "services", { path: "services", type: "tree", sha: "sha" }, scopes)).toBe("outside_product_scope");
    expect(scopePruneReason("apps", "apps/checkout/src/server.ts", { ...raw, path: "apps/checkout/src/server.ts" }, scopes)).toBeUndefined();
    expect(baseSignals("app/page.tsx")).toEqual(["entrypoint", "service", "frontend"]);
    expect(baseSignals("database/migration.sql")).toEqual(["database", "migration"]);
    expect(baseSignals("worker.ts")).toEqual(["queue", "worker", "service"]);
  });
});

describe("Remote Source Index", () => {
  it("lazily expands scoped trees and prunes dependency directories", async () => {
    const { backend } = createBackend();
    const index = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend },
    );
    expect(index.identity).toMatchObject({ repository: "gzhanlei/commerce", revision, rootTreeSha: "tree-root", backend: "github_api" });

    const root = await index.listRoot();
    expect(root.entries.map((entry) => entry.path)).toEqual(["apps", "README.md", "third_party"]);
    expect(root.entries.find((entry) => entry.path === "third_party")?.pruned).toEqual({ reason: "third_party" });
    expect(root.entries.find((entry) => entry.path === "README.md")?.signals).toContain("manifest");

    await expect(index.listDir("services/api")).rejects.toThrow("path is outside product scope");

    await index.expandPath("apps");
    const scope = await index.listDir("apps/checkout");
    expect(scope.entries.map((entry) => entry.path)).toEqual(["apps/checkout/package.json", "apps/checkout/src"]);
  });

  it("reads verified line ranges, caches blobs, and only materializes selected evidence", async () => {
    const { backend, calls } = createBackend();
    const written: Array<{ path: string; bytes: number }> = [];
    const filesystem = {
      async mkdir() {},
      async writeFile(path: string, data: Uint8Array) {
        written.push({ path, bytes: data.byteLength });
      },
    };
    const index = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend, dependencies: { filesystem } },
    );
    const first = await index.readLines({
      path: "apps/checkout/src/server.ts",
      startLine: 2,
      endLine: 3,
      requestedBy: "planner",
      reason: "verify runtime entrypoint",
    });
    expect(first.lines).toEqual(["  return \"checkout\";", "}"]);
    expect(first.blobSha).toBe(blob(new TextDecoder().decode(await backend.fetchBlob({ owner: "gzhanlei", repo: "commerce", revision }, "apps/checkout/src/server.ts", ""))));
    expect(first.verified).toBe(true);

    const readsBeforeSecondFetch = calls.blobs;
    const second = await index.readLines({ ...first, startLine: 2, endLine: 3, requestedBy: "planner", reason: "re-read" });
    expect(second.cacheState).toBe("cached");
    expect(calls.blobs).toBe(readsBeforeSecondFetch);

    await expect(index.readLines({
      path: "third_party/sdk/index.ts",
      startLine: 1,
      endLine: 1,
      requestedBy: "ai_explorer",
      reason: "outside scope",
    })).rejects.toThrow("path is outside product scope");

    const evidence = await index.materializeEvidenceRoot({
      revision: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [{ path: "apps/checkout" }],
      paths: [
        { path: "apps/checkout/package.json", blobSha: blob(new TextDecoder().decode(await backend.fetchBlob({ owner: "gzhanlei", repo: "commerce", revision }, "apps/checkout/package.json", ""))) },
        { path: "third_party/sdk/index.ts", blobSha: "ignored" },
      ],
      outputRoot: "/tmp/evidence",
    });
    expect(evidence).toMatchObject({ kind: "materialized_files", fileCount: 1, verified: false });
    expect(evidence.missingPaths).toEqual(["third_party/sdk/index.ts"]);
    expect(written).toHaveLength(1);
    expect(written[0].path).toContain("apps/checkout/package.json");
  });

  it("classifies excluded source entries and evicts blob cache", async () => {
    const rootEntries = [
      { path: "services", type: "tree" as const, sha: "tree-services" },
      { path: "third_party", type: "tree" as const, sha: "tree-third" },
      { path: "node_modules", type: "tree" as const, sha: "tree-modules" },
      { path: "build", type: "tree" as const, sha: "tree-build" },
      { path: "generated/thing.ts", type: "blob" as const, sha: "ignored", size: 10 },
      { path: "icon.png", type: "blob" as const, sha: "ignored", size: 10 },
      { path: "huge.ts", type: "blob" as const, sha: "ignored", size: 2_000 },
    ];
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        if (path) throw new Error("unexpected expansion");
        return { entries: rootEntries, truncated: false };
      },
      async fetchBlob() {
        throw new Error("unexpected blob");
      },
    };
    const index = await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, {
      access: {},
      scopeRoots: [{ path: "apps/checkout" }],
      backend,
      pruning: { excludedExtensions: [".png"], maxTrackedSourceBytes: 1_000 },
      cache: { maxCachedBlobs: 1 },
    });
    const reasons = new Map((await index.listRoot()).entries.map((entry) => [entry.path, entry.pruned?.reason]));
    expect(reasons.get("services")).toBe("outside_product_scope");
    expect(reasons.get("third_party")).toBe("third_party");
    expect(reasons.get("node_modules")).toBe("dependency_directory");
    expect(reasons.get("build")).toBe("build_output");
    expect(reasons.get("generated/thing.ts")).toBe("generated");
    expect(reasons.get("icon.png")).toBe("binary_asset");
    expect(reasons.get("huge.ts")).toBe("too_large");
  });

  it("enforces the configured blob cache size and allows root manifests", async () => {
    const { backend } = createBackend();
    const index = await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend, cache: { maxCachedBlobs: 1 } });
    const rootManifest = await index.readLines({ path: "README.md", startLine: 1, endLine: 1, requestedBy: "profile", reason: "root manifest" });
    expect(rootManifest.lines[0]).toBe("checkout platform");
    await index.readLines({ path: "apps/checkout/package.json", startLine: 1, endLine: 1, requestedBy: "profile", reason: "manifest" });
    await index.readLines({ path: "apps/checkout/src/server.ts", startLine: 1, endLine: 1, requestedBy: "profile", reason: "entrypoint" });
    expect((await index.statPath("apps/checkout/package.json"))?.cacheState).toBe("miss");
    expect((await index.statPath("apps/checkout/src/server.ts"))?.cacheState).toBe("cached");
  });

  it("reports blob metadata and rejects invalid reads", async () => {
    const { backend } = createBackend();
    const index = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend },
    );
    await expect(index.readLines({ path: "apps/checkout/src/server.ts", startLine: 0, endLine: 1, requestedBy: "planner", reason: "invalid" })).rejects.toThrow("line range must start at 1");
    expect(await index.statPath("apps/checkout/missing.ts")).toBeNull();
    const before = await index.statPath("apps/checkout/package.json");
    expect(before?.cacheState).toBe("miss");
    await index.readLines({ path: "apps/checkout/package.json", startLine: 1, endLine: 1, requestedBy: "planner", reason: "manifest" });
    const after = await index.statPath("apps/checkout/package.json");
    expect(after?.cacheState).toBe("cached");
    expect(after?.lineCount).toBeGreaterThan(0);
  });

  it("falls back to Node filesystem, reports partial indexes, and validates sparse evidence", async () => {
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const files = new Map([["apps/checkout/package.json", "{\n  \"name\": \"checkout\"\n}\n"], ["apps/checkout/binary.bin", "not-utf8\n"]]);
    const sha = (path: string) => gitBlobSha(files.get(path)!);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "root" };
      },
      async listTree(_source, _treeSha, path) {
        if (path === "") return { truncated: true, entries: [{ path: "apps", type: "tree", sha: "tree-apps" }] };
        if (path === "apps") return { truncated: false, entries: [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }] };
        return { truncated: false, entries: [
          { path: "apps/checkout/package.json", type: "blob", sha: sha("apps/checkout/package.json"), size: Buffer.byteLength(files.get("apps/checkout/package.json")!) },
          { path: "apps/checkout/binary.bin", type: "blob", sha: sha("apps/checkout/binary.bin"), size: 9 },
          { path: "apps/checkout/src", type: "tree", sha: "tree-src" },
        ] };
      },
      async fetchBlob(_source, path) {
        return new TextEncoder().encode(files.get(path)!);
      },
    };
    const index = await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend });
    expect(index.identity.status).toBe("partial");
    expect((await index.listRoot()).status).toBe("partial");
    expect(await index.statPath("apps/checkout/generated/x.ts")).toBeNull();
    await expect(index.readLines({ path: "apps/checkout/src", startLine: 1, endLine: 1, requestedBy: "planner", reason: "tree" })).rejects.toThrow("source file was not found");
    await expect(index.readLines({ path: "apps/checkout/binary.bin", startLine: 1, endLine: 1, requestedBy: "planner", reason: "binary" })).rejects.toThrow("source file is pruned (binary_asset)");

    const root = await mkdtemp(join(tmpdir(), "radar-evidence-"));
    const result = await index.materializeEvidenceRoot({
      revision: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [{ path: "apps/checkout" }],
      paths: [
        { path: "apps/checkout/package.json", blobSha: sha("apps/checkout/package.json") },
        { path: "apps/checkout/package.json", blobSha: "wrong-sha" },
      ],
      outputRoot: root,
    });
    expect(result.verified).toBe(false);
    expect(result.fileCount).toBe(1);
    expect(await readFile(join(root, "apps/checkout/package.json"), "utf8")).toBe(files.get("apps/checkout/package.json"));
    await rm(root, { recursive: true, force: true });
  });

  it("rejects root files that are outside product scope", async () => {
    const { backend } = createBackend();
    const index = await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend });
    await expect(index.readLines({ path: "LICENSE", startLine: 1, endLine: 1, requestedBy: "ai_explorer", reason: "root file" })).rejects.toThrow("path is outside product scope");
  });

  it("rejects blob content whose Git SHA does not match the pinned tree entry", async () => {
    const content = "export const bad = true;\n";
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        if (path === "apps") return { entries: [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }], truncated: false };
        if (path === "apps/checkout") return { entries: [{ path: "apps/checkout/bad.ts", type: "blob", sha: "bad-sha", size: content.length }], truncated: false };
        return { entries: [{ path: "apps", type: "tree", sha: "tree-apps" }], truncated: false };
      },
      async fetchBlob(_source, path, _blobSha) {
        if (path !== "apps/checkout/bad.ts") throw new Error("unexpected blob");
        return new TextEncoder().encode(content);
      },
    };
    const index = await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, { access: {}, scopeRoots: [{ path: "apps/checkout" }], backend });
    await expect(index.readLines({ path: "apps/checkout/bad.ts", startLine: 1, endLine: 1, requestedBy: "planner", reason: "verify" })).rejects.toThrow("blob SHA mismatch");
  });
});
