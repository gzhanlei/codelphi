import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRemoteSourceIndex, gitBlobSha, type RemoteSourceBackend, type SourceRevisionRef } from "../lib/remote-source-index";
import { createSlicePlanner, confidenceLabel, reasonFor, type SlicePlanningState, type SourceSlice } from "../lib/slice-planner";
import type { SourceLineSlice } from "../lib/remote-source-index/types";

const ref: SourceRevisionRef = { owner: "gzhanlei", repo: "commerce", revision: "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937" };
const contents = new Map([
  ["README.md", "checkout platform\n"],
  ["apps/checkout/package.json", "{\n  \"dependencies\": {\"next\": \"16.0.0\", \"express\": \"4.0.0\"}\n}\n"],
  ["apps/checkout/app/page.tsx", "export default function Page() {}\n"],
  ["apps/checkout/src/server.ts", "line one\nline two\nline three\nline four\n"],
]);
const contentSha = (path: string) => gitBlobSha(contents.get(path)!);

function createControlledBackend(calls = { trees: 0, blobs: 0 }) {
  const trees = new Map<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>([
    ["", [
      { path: "apps", type: "tree", sha: "tree-apps" },
      { path: "README.md", type: "blob", sha: contentSha("README.md"), size: Buffer.byteLength(contents.get("README.md")!) },
      { path: "docs", type: "tree", sha: "tree-docs" },
      { path: "LICENSE", type: "blob", sha: "blob-license", size: 12 },
    ]],
    ["apps", [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }]],
    ["apps/checkout", [
      { path: "apps/checkout/package.json", type: "blob", sha: contentSha("apps/checkout/package.json"), size: Buffer.byteLength(contents.get("apps/checkout/package.json")!) },
      { path: "apps/checkout/app", type: "tree", sha: "tree-app" },
      { path: "apps/checkout/src", type: "tree", sha: "tree-src" },
    ]],
    ["apps/checkout/app", [{ path: "apps/checkout/app/page.tsx", type: "blob", sha: contentSha("apps/checkout/app/page.tsx"), size: Buffer.byteLength(contents.get("apps/checkout/app/page.tsx")!) }]],
    ["apps/checkout/src", [{ path: "apps/checkout/src/server.ts", type: "blob", sha: contentSha("apps/checkout/src/server.ts"), size: Buffer.byteLength(contents.get("apps/checkout/src/server.ts")!) }]],
  ]);
  const backend: RemoteSourceBackend = {
    kind: "github_api",
    async resolveRevision() {
      return { rootTreeSha: "root-tree-sha" };
    },
    async listTree(_source, _treeSha, path) {
      calls.trees += 1;
      return { entries: trees.get(path) ?? [], truncated: false };
    },
    async fetchBlob(_source, path) {
      calls.blobs += 1;
      return new TextEncoder().encode(contents.get(path)!);
    },
  };
  return { backend, calls };
}

describe("Remote Source Index behavior", () => {
  it("exposes verified revision metadata, scoped listings, budgets, cache state, and sparse evidence", async () => {
    const { backend, calls } = createControlledBackend();
    const written: Array<{ path: string; text: string }> = [];
    const index = await createRemoteSourceIndex(ref, {
      scopeRoots: [{ path: "apps/checkout", role: "web" }],
      backend,
      budgets: { maxTreeExpansions: 3, maxBlobFetches: 2, maxBlobBytes: 1_000, maxLinesPerRead: 3, maxTotalContentBytes: 10_000 },
      dependencies: {
        filesystem: {
          async mkdir() {},
          async writeFile(path, data) {
            written.push({ path, text: new TextDecoder().decode(data) });
          },
        },
        now: () => new Date("2026-11-02T12:00:00.000Z"),
      },
    });

    expect(index.identity).toEqual({
      repository: "gzhanlei/commerce",
      revision: ref.revision,
      rootTreeSha: "root-tree-sha",
      backend: "github_api",
      status: "indexed",
    });
    expect(index.metrics).toEqual({ treeExpansions: 0, blobFetches: 0, contentBytes: 0 });

    const root = await index.listRoot();
    expect(root.status).toBe("indexed");
    expect(root.metrics).toEqual({ entryCount: 4, prunedCount: 2 });
    expect(root.entries.map((entry) => [entry.path, entry.pruned?.reason])).toEqual([
      ["apps", undefined],
      ["README.md", undefined],
      ["docs", "outside_product_scope"],
      ["LICENSE", "outside_product_scope"],
    ]);
    expect(root.entries[1].signals).toEqual(["manifest"]);

    await index.expandPath("apps");
    const scope = await index.listDir("apps/checkout");
    expect(index.metrics.treeExpansions).toBe(2);
    expect(scope.entries.map((entry) => entry.path)).toEqual(["apps/checkout/package.json", "apps/checkout/app", "apps/checkout/src"]);

    const first = await index.readLines({
      path: "apps/checkout/src/server.ts",
      startLine: 2,
      endLine: 99,
      requestedBy: "planner",
      reason: "verify entrypoint",
    });
    const selectedText = "line two\nline three\nline four";
    expect(first).toEqual({
      path: "apps/checkout/src/server.ts",
      blobSha: contentSha("apps/checkout/src/server.ts"),
      treeEntrySha: contentSha("apps/checkout/src/server.ts"),
      startLine: 2,
      endLine: 4,
      lines: ["line two", "line three", "line four"],
      byteSize: Buffer.byteLength(selectedText),
      lineCount: 4,
      verified: true,
      cacheState: "fetched",
      readReceipt: { requestedBy: "planner", reason: "verify entrypoint", fetchedAt: "2026-11-02T12:00:00.000Z" },
    });
    expect(index.metrics.blobFetches).toBe(1);

    const second = await index.readLines({ ...first, startLine: 2, endLine: 3, requestedBy: "planner", reason: "cache hit" });
    expect(second.cacheState).toBe("cached");
    expect(calls.blobs).toBe(1);

    const stat = await index.statPath("apps/checkout/src/server.ts");
    expect(stat).toEqual({
      path: "apps/checkout/src/server.ts",
      blobSha: contentSha("apps/checkout/src/server.ts"),
      treeEntrySha: contentSha("apps/checkout/src/server.ts"),
      byteSize: Buffer.byteLength(contents.get("apps/checkout/src/server.ts")!),
      lineCount: 4,
      cacheState: "cached",
    });

    const evidence = await index.materializeEvidenceRoot({
      revision: ref,
      scopeRoots: [{ path: "apps/checkout" }],
      paths: [
        { path: "apps/checkout/package.json", blobSha: contentSha("apps/checkout/package.json") },
        { path: "apps/checkout/missing.json", blobSha: contentSha("apps/checkout/package.json") },
      ],
      outputRoot: "/controlled/evidence",
    });
    expect(evidence).toEqual({
      rootPath: "/controlled/evidence",
      kind: "materialized_files",
      fileCount: 1,
      byteSize: Buffer.byteLength(contents.get("apps/checkout/package.json")!),
      verified: false,
      missingPaths: ["apps/checkout/missing.json"],
    });
    expect(written).toEqual([{ path: "/controlled/evidence/apps/checkout/package.json", text: contents.get("apps/checkout/package.json") }]);
  });

  it("enforces read, blob, tree, and content budgets", async () => {
    const { backend } = createControlledBackend();
    const index = await createRemoteSourceIndex(ref, {
      scopeRoots: [{ path: "apps/checkout" }],
      backend,
      budgets: { maxTreeExpansions: 0, maxBlobFetches: 1, maxBlobBytes: 10, maxLinesPerRead: 3, maxTotalContentBytes: 10 },
    });
    await expect(index.listDir("apps")).rejects.toThrow("tree expansion budget was exhausted");

    const contentBudget = await createRemoteSourceIndex(ref, {
      scopeRoots: [{ path: "apps/checkout" }],
      backend,
      budgets: { maxTreeExpansions: 3, maxBlobFetches: 1, maxBlobBytes: 1_000, maxLinesPerRead: 3, maxTotalContentBytes: 5 },
    });
    await expect(contentBudget.readLines({ path: "apps/checkout/package.json", startLine: 1, endLine: 1, requestedBy: "profile", reason: "manifest" })).rejects.toThrow("remote source content budget was exhausted");

    const openWithBlobs = await createRemoteSourceIndex(ref, {
      scopeRoots: [{ path: "apps/checkout" }],
      backend,
      budgets: { maxTreeExpansions: 3, maxBlobFetches: 1, maxBlobBytes: 1_000, maxLinesPerRead: 3, maxTotalContentBytes: 10_000 },
    });
    await openWithBlobs.readLines({ path: "apps/checkout/package.json", startLine: 1, endLine: 1, requestedBy: "profile", reason: "manifest" });
    await expect(openWithBlobs.readLines({ path: "apps/checkout/src/server.ts", startLine: 1, endLine: 1, requestedBy: "profile", reason: "entrypoint" })).rejects.toThrow("blob fetch budget was exhausted");

    const oversized = await createRemoteSourceIndex(ref, {
      scopeRoots: [{ path: "apps/checkout" }],
      backend,
      budgets: { maxTreeExpansions: 3, maxBlobFetches: 1, maxBlobBytes: 10, maxLinesPerRead: 3, maxTotalContentBytes: 10_000 },
    });
    await expect(oversized.readLines({ path: "apps/checkout/package.json", startLine: 1, endLine: 1, requestedBy: "profile", reason: "manifest" })).rejects.toThrow("source blob exceeds max bytes");
  });
});

describe("Slice Planner behavior", () => {
  it("selects exact deterministic source files and profile metrics", async () => {
    const { backend } = createControlledBackend();
    const index = await createRemoteSourceIndex(ref, { scopeRoots: [{ path: "apps/checkout", role: "web" }], backend });
    const planner = createSlicePlanner({ now: () => 1_000 });
    const result = await planner.plan({
      product: { id: 7, slug: "checkout", name: "Checkout" },
      repository: ref,
      scopeRoots: [{ path: "apps/checkout", role: "web" }],
      budgets: { maxSelectedFiles: 10, maxSelectedLineRanges: 100, maxPlannerContentBytes: 100_000, maxAiContextSourceBytes: 100_000, maxAiReadCalls: 2, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
      plannerVersion: "v1-test",
      profileVersion: "profiles-v1",
    }, index);

    expect(result.status).toBe("completed");
    const slice: SourceSlice = result.slice!;
    expect(slice.product).toEqual({ id: 7, slug: "checkout", name: "Checkout" });
    expect(slice.repository).toBe("gzhanlei/commerce");
    expect(slice.revision).toBe(ref.revision);
    expect(slice.confidence).toBe("high");
    expect(slice.files.map((file) => [file.path, file.reason, file.signals])).toEqual([
      ["apps/checkout/package.json", "manifest", ["manifest"]],
      ["apps/checkout/app/page.tsx", "entrypoint", ["entrypoint", "frontend"]],
      ["apps/checkout/src/server.ts", "entrypoint", ["entrypoint"]],
    ]);
    expect(slice.files.every((file) => /^[0-9a-f]{40}$/.test(file.blobSha))).toBe(true);
    expect(slice.evidenceClaims.map((claim) => [claim.path, claim.kind, claim.confidence])).toEqual([
      ["apps/checkout/package.json", "component", "high"],
      ["apps/checkout/app/page.tsx", "component", "high"],
      ["apps/checkout/src/server.ts", "component", "high"],
    ]);
    expect(slice.evidenceClaims[0].quoteSha256).toBe(createHash("sha256").update(contents.get("apps/checkout/package.json")!.trimEnd(), "utf8").digest("hex"));
    expect(slice.metrics.profileMatches.map((match) => [match.profileId, match.confidence])).toEqual([
      ["next-web", 0.9],
      ["node-api", 0.82],
    ]);
    expect(slice.metrics).toEqual({
      treeExpansions: 4,
      blobFetches: 3,
      selectedFiles: 3,
      selectedLineRanges: 3,
      selectedContentBytes: slice.files.reduce((total, file) => total + file.byteSize, 0),
      aiReadCalls: 0,
      prunedPathCount: 0,
      budgetsRemaining: { selectedFiles: 7, selectedLineRanges: 97, plannerContentBytes: 100_000 - slice.metrics.selectedContentBytes, aiReadCalls: 2 },
      wallClockMs: 0,
      profileMatches: [
        { profileId: "next-web", confidence: 0.9, matchedSignals: [
          { path: "apps/checkout/package.json", signal: "manifest" },
          { path: "apps/checkout/app/page.tsx", signal: "entrypoint" },
          { path: "apps/checkout/app/page.tsx", signal: "frontend" },
        ] },
        { profileId: "node-api", confidence: 0.82, matchedSignals: [{ path: "apps/checkout/package.json", signal: "manifest" }] },
      ],
    });
    expect(slice.metrics.selectedFiles).toBe(3);
  });

  it("maps infrastructure files to deterministic slice reasons", async () => {
    const planner = createSlicePlanner({ now: () => 1_000 });
    const files = new Map([
      ["apps/api/package.json", JSON.stringify({ dependencies: { fastify: "4.0.0" } })],
      ["apps/api/routes.ts", "export const routes = [];\n"],
      ["apps/api/orders.db.ts", "export const db = {};\n"],
      ["apps/api/queue.ts", "export const queue = {};\n"],
      ["apps/api/auth.ts", "export const auth = {};\n"],
      ["apps/api/Dockerfile", "FROM node:22\n"],
    ]);
    const blob = (path: string) => gitBlobSha(files.get(path)!);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        const entries = {
          "": [{ path: "apps", type: "tree", sha: "tree-apps" }],
          apps: [{ path: "apps/api", type: "tree", sha: "tree-api" }],
          "apps/api": [
            { path: "apps/api/package.json", type: "blob", sha: blob("apps/api/package.json"), size: 42 },
            { path: "apps/api/routes.ts", type: "blob", sha: blob("apps/api/routes.ts"), size: 28 },
            { path: "apps/api/orders.db.ts", type: "blob", sha: blob("apps/api/orders.db.ts"), size: 26 },
            { path: "apps/api/queue.ts", type: "blob", sha: blob("apps/api/queue.ts"), size: 26 },
            { path: "apps/api/auth.ts", type: "blob", sha: blob("apps/api/auth.ts"), size: 25 },
            { path: "apps/api/Dockerfile", type: "blob", sha: blob("apps/api/Dockerfile"), size: 15 },
          ],
        } as Record<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>;
        return { entries: entries[path] ?? [], truncated: false };
      },
      async fetchBlob(_source, path) {
        return new TextEncoder().encode(files.get(path)!);
      },
    };
    const index = await createRemoteSourceIndex(ref, { scopeRoots: [{ path: "apps/api" }], backend });
    const result = await createSlicePlanner().plan({
      product: { id: 8, slug: "api", name: "API" },
      repository: ref,
      scopeRoots: [{ path: "apps/api" }],
      budgets: { maxSelectedFiles: 10, maxSelectedLineRanges: 100, maxPlannerContentBytes: 100_000, maxAiContextSourceBytes: 100_000, maxAiReadCalls: 0, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
      plannerVersion: "v1-test",
      profileVersion: "profiles-v1",
    }, index);
    expect(result.slice?.files.map((file) => [file.path, file.reason])).toEqual([
      ["apps/api/package.json", "manifest"],
      ["apps/api/auth.ts", "auth"],
      ["apps/api/Dockerfile", "manifest"],
      ["apps/api/orders.db.ts", "database"],
      ["apps/api/queue.ts", "queue"],
      ["apps/api/routes.ts", "route"],
    ]);
    expect(result.slice?.metrics.profileMatches[0]?.profileId).toBe("node-api");
  });

  it("maps reason priority and confidence thresholds", () => {
    expect(reasonFor(["manifest", "entrypoint", "route", "database", "queue", "auth", "deployment", "frontend", "native"])).toBe("manifest");
    expect(reasonFor(["entrypoint", "route", "database", "queue", "auth", "deployment", "frontend", "native"])).toBe("entrypoint");
    expect(reasonFor(["route", "database", "queue", "auth", "deployment", "frontend", "native"])).toBe("route");
    expect(reasonFor(["database", "queue", "auth", "deployment", "frontend", "native"])).toBe("database");
    expect(reasonFor(["queue", "auth", "deployment", "frontend", "native"])).toBe("queue");
    expect(reasonFor(["auth", "deployment", "frontend", "native"])).toBe("auth");
    expect(reasonFor(["deployment", "frontend", "native"])).toBe("deployment");
    expect(reasonFor(["frontend", "native"])).toBe("service");
    expect(reasonFor([])).toBe("service");
    expect(confidenceLabel(0.72)).toBe("high");
    expect(confidenceLabel(0.719)).toBe("medium");
    expect(confidenceLabel(0.5)).toBe("medium");
    expect(confidenceLabel(0.499)).toBe("low");
  });

  it("gates every targeted read and records exact approval state", async () => {
    const planner = createSlicePlanner();
    const state: SlicePlanningState = {
      input: {
        product: { id: 7, slug: "checkout", name: "Checkout" },
        repository: ref,
        scopeRoots: [{ path: "apps/checkout" }],
        budgets: { maxSelectedFiles: 10, maxSelectedLineRanges: 100, maxPlannerContentBytes: 10_000, maxAiContextSourceBytes: 10_000, maxAiReadCalls: 1, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
        plannerVersion: "v1-test",
        profileVersion: "profiles-v1",
      },
      revision: {} as SlicePlanningState["revision"],
      phase: "targeted_exploration",
      scope: { status: "resolved", unresolved: [], scopeRoots: [{ path: "apps/checkout" }] },
      selected: new Map(),
      fileContents: new Map(),
      evidenceClaims: [],
      questions: [],
      profileMatches: [],
      unresolved: [],
      diagnostics: [],
      budgetsRemaining: { selectedFiles: 10, selectedLineRanges: 100, plannerContentBytes: 10_000, aiReadCalls: 1, startedAt: Date.now() },
    };

    expect(planner.evaluateTargetedRead(state, { path: "README.md", startLine: 1, endLine: 1, requestedBy: "ai_explorer", reason: "outside" })).toEqual({
      allowed: false,
      code: "scope_root_not_found",
      message: "targeted read is outside product scope: README.md",
    });
    expect(planner.evaluateTargetedRead(state, { path: "apps/checkout/file.ts", startLine: 0, endLine: 1, requestedBy: "ai_explorer", reason: "invalid" })).toEqual({
      allowed: false,
      code: "read_request_invalid",
      message: "line range is invalid",
    });
    const decision = planner.evaluateTargetedRead(state, { path: "apps/checkout/src/server.ts", startLine: 2, endLine: 4, requestedBy: "ai_explorer", reason: "verify payment edge" });
    expect(decision).toEqual({
      allowed: true,
      approval: {
        requestId: "apps/checkout/src/server.ts:2-4",
        path: "apps/checkout/src/server.ts",
        startLine: 2,
        endLine: 4,
        reason: "verify payment edge",
        remainingReadCalls: 0,
        remainingContentBytes: 10_000,
      },
    });
    if (!decision.allowed) throw new Error("expected approval");

    const slice: SourceLineSlice = {
      path: "apps/checkout/src/server.ts",
      blobSha: "blob-sha",
      treeEntrySha: "tree-blob-sha",
      startLine: 2,
      endLine: 4,
      lines: ["line two", "line three"],
      byteSize: 21,
      lineCount: 4,
      verified: true,
      cacheState: "fetched",
      readReceipt: { requestedBy: "ai_explorer", reason: "verify payment edge", fetchedAt: "2026-11-02T00:00:00.000Z" },
    };
    const updated = planner.applyTargetedRead(state, decision.approval, slice);
    expect(updated.budgetsRemaining.aiReadCalls).toBe(0);
    expect(updated.selected.get("apps/checkout/src/server.ts")).toEqual({
      path: "apps/checkout/src/server.ts",
      blobSha: "blob-sha",
      treeEntrySha: "tree-blob-sha",
      reason: "ai_targeted",
      byteSize: 21,
      lineRanges: [{ startLine: 2, endLine: 4, purpose: "verify payment edge" }],
      signals: [],
    });
    expect(updated.evidenceClaims[0]).toEqual({
      kind: "component",
      claim: "verify payment edge",
      path: "apps/checkout/src/server.ts",
      startLine: 2,
      endLine: 4,
      quoteSha256: createHash("sha256").update("line two\nline three", "utf8").digest("hex"),
      confidence: "medium",
    });
    await expect(planner.finalize(updated)).resolves.toEqual({ status: "underdetermined", missing: ["supported stack profile was not identified"], diagnostics: [{ code: "profile_confidence_low", message: "no stack profile was identified" }] });
  });
});


