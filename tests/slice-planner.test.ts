import { describe, expect, it } from "vitest";
import { createRemoteSourceIndex, gitBlobSha, type RemoteSourceBackend } from "../lib/remote-source-index";
import { createSlicePlanner, type SlicePlanningState, type StackProfileId } from "../lib/slice-planner";

const revision = "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937";

function createCheckoutBackend(): RemoteSourceBackend {
  const files = new Map([
    ["apps/checkout/package.json", JSON.stringify({ dependencies: { next: "16.0.0", react: "19.0.0", express: "4.0.0" } })],
    ["apps/checkout/app/page.tsx", "export default function CheckoutPage() {\n  return null;\n}\n"],
    ["apps/checkout/src/server.ts", "export const server = \"api\";\n"],
    ["services/api/go.mod", "module checkout\n\ngo 1.22\n"],
  ]);
  const blob = (path: string) => gitBlobSha(files.get(path)!);
  const trees = new Map<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>([
    ["", [{ path: "apps", type: "tree", sha: "tree-apps" }]],
    ["apps", [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }]],
    ["apps/checkout", [
      { path: "apps/checkout/package.json", type: "blob", sha: blob("apps/checkout/package.json"), size: 60 },
      { path: "apps/checkout/app", type: "tree", sha: "tree-app" },
      { path: "apps/checkout/src", type: "tree", sha: "tree-src" },
    ]],
    ["apps/checkout/app", [{ path: "apps/checkout/app/page.tsx", type: "blob", sha: blob("apps/checkout/app/page.tsx"), size: 58 }]],
    ["apps/checkout/src", [{ path: "apps/checkout/src/server.ts", type: "blob", sha: blob("apps/checkout/src/server.ts"), size: 32 }]],
  ]);
  return {
    kind: "github_api",
    async resolveRevision() {
      return { rootTreeSha: "tree-root" };
    },
    async listTree(_ref, _treeSha, path) {
      return { entries: trees.get(path) ?? [], truncated: false };
    },
    async fetchBlob(_ref, path, _blobSha) {
      return new TextEncoder().encode(files.get(path)!);
    },
  };
}

describe("Slice Planner", () => {
  it("rejects products without product scope", async () => {
    const index = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { scopeRoots: [], backend: createCheckoutBackend() },
    );
    const planner = createSlicePlanner();
    const result = await planner.plan({
      product: { id: 1, slug: "checkout", name: "Checkout" },
      repository: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [],
      budgets: { maxSelectedFiles: 20, maxSelectedLineRanges: 100, maxPlannerContentBytes: 100_000, maxAiContextSourceBytes: 100_000, maxAiReadCalls: 10, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
      plannerVersion: "v1",
      profileVersion: "v1",
    }, index);
    expect(result.status).toBe("scope_ambiguous");
    expect(result.diagnostics[0]?.code).toBe("scope_ambiguous");
  });

  it("builds a deterministic slice from manifests and entrypoints", async () => {
    const index = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { scopeRoots: [{ path: "apps/checkout", role: "web" }], backend: createCheckoutBackend() },
    );
    const planner = createSlicePlanner();
    const result = await planner.plan({
      product: { id: 1, slug: "checkout", name: "Checkout" },
      repository: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [{ path: "apps/checkout", role: "web" }],
      budgets: { maxSelectedFiles: 20, maxSelectedLineRanges: 100, maxPlannerContentBytes: 100_000, maxAiContextSourceBytes: 100_000, maxAiReadCalls: 10, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
      plannerVersion: "v1",
      profileVersion: "v1",
    }, index);

    expect(result.status).toBe("completed");
    expect(result.slice?.scopeRoots).toEqual([{ path: "apps/checkout", role: "web" }]);
    expect(result.slice?.files.map((file) => file.path)).toEqual([
      "apps/checkout/package.json",
      "apps/checkout/app/page.tsx",
      "apps/checkout/src/server.ts",
    ]);
    const profiles = result.slice?.metrics.profileMatches.map((profile) => profile.profileId) ?? [];
    expect(profiles).toContain<StackProfileId>("next-web");
    expect(result.slice?.metrics.selectedFiles).toBe(3);
    expect(result.slice?.files.every((file) => /^[0-9a-f]{40}$/.test(file.blobSha))).toBe(true);
  });

  it("returns underdetermined when a scope root is absent or no profile is supported", async () => {
    const index = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { scopeRoots: [{ path: "services/api", role: "api" }], backend: createCheckoutBackend() },
    );
    const planner = createSlicePlanner();
    const input = {
      product: { id: 1, slug: "api", name: "API" },
      repository: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [{ path: "services/api", role: "api" as const }],
      budgets: { maxSelectedFiles: 20, maxSelectedLineRanges: 100, maxPlannerContentBytes: 100_000, maxAiContextSourceBytes: 100_000, maxAiReadCalls: 10, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
      plannerVersion: "v1",
      profileVersion: "v1",
    };
    expect((await planner.plan(input, index)).status).toBe("underdetermined");

    const sourceIndex = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { scopeRoots: [{ path: "apps/checkout", role: "web" }], backend: createCheckoutBackend() },
    );
    const unsupported = await planner.plan({ ...input, scopeRoots: [{ path: "apps/checkout", role: "web" }], budgets: { ...input.budgets, maxSelectedFiles: 0 } }, sourceIndex);
    expect(unsupported.status).toBe("underdetermined");
    expect(unsupported.diagnostics[0]?.code).toBe("profile_confidence_low");

    const boundedIndex = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "commerce", revision },
      { scopeRoots: [{ path: "apps/checkout", role: "web" }], backend: createCheckoutBackend(), budgets: { maxTreeExpansions: 0 } },
    );
    const budgeted = await planner.plan({ ...input, scopeRoots: [{ path: "apps/checkout", role: "web" }] }, boundedIndex);
    expect(budgeted.status).toBe("underdetermined");
    expect(budgeted.diagnostics[0]?.message).toContain("tree expansion budget");
  });

  it("reports failed planning when connected expansion fails unexpectedly", async () => {
    const files = new Map([[
      "apps/checkout/package.json",
      JSON.stringify({ dependencies: { next: "16.0.0" } }),
    ]]);
    const blob = (path: string) => gitBlobSha(files.get(path)!);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_ref, _treeSha, path) {
        if (path === "") return { entries: [{ path: "apps", type: "tree", sha: "tree-apps" }], truncated: false };
        if (path === "apps") return { entries: [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }], truncated: false };
        if (path === "apps/checkout") return {
          entries: [
            { path: "apps/checkout/package.json", type: "blob", sha: blob("apps/checkout/package.json"), size: 40 },
            { path: "apps/checkout/app", type: "tree", sha: "tree-app" },
          ],
          truncated: false,
        };
        throw new Error("connection reset");
      },
      async fetchBlob(_ref, path) {
        return new TextEncoder().encode(files.get(path)!);
      },
    };
    const index = await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, { scopeRoots: [{ path: "apps/checkout" }], backend });
    const result = await createSlicePlanner().plan({
      product: { id: 1, slug: "checkout", name: "Checkout" },
      repository: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [{ path: "apps/checkout" }],
      budgets: { maxSelectedFiles: 10, maxSelectedLineRanges: 100, maxPlannerContentBytes: 100_000, maxAiContextSourceBytes: 100_000, maxAiReadCalls: 10, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
      plannerVersion: "v1",
      profileVersion: "v1",
    }, index);
    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]?.message).toBe("connection reset");
  });

  it("matches Go and Android profiles from scoped manifests and entrypoints", async () => {
    const planner = createSlicePlanner();
    const budgets = { maxSelectedFiles: 20, maxSelectedLineRanges: 100, maxPlannerContentBytes: 100_000, maxAiContextSourceBytes: 100_000, maxAiReadCalls: 10, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 };

    const files = new Map([
      ["services/api/go.mod", "module checkout\n\ngo 1.22\n"],
      ["services/api/src/main.go", "package main\n\nfunc main() {}\n"],
      ["apps/mobile/AndroidManifest.xml", "<manifest><application /></manifest>\n"],
      ["apps/mobile/build.gradle", "android { }\n"],
      ["apps/mobile/MainActivity.kt", "class MainActivity\n"],
    ]);
    const blob = (path: string) => gitBlobSha(files.get(path)!);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_ref, _treeSha, path) {
        const entries = {
          "": [{ path: "services", type: "tree", sha: "tree-services" }, { path: "apps", type: "tree", sha: "tree-apps" }],
          services: [{ path: "services/api", type: "tree", sha: "tree-api" }],
          "services/api": [
            { path: "services/api/go.mod", type: "blob", sha: blob("services/api/go.mod"), size: 24 },
            { path: "services/api/src", type: "tree", sha: "tree-go-src" },
          ],
          "services/api/src": [{ path: "services/api/src/main.go", type: "blob", sha: blob("services/api/src/main.go"), size: 29 }],
          apps: [{ path: "apps/mobile", type: "tree", sha: "tree-mobile" }],
          "apps/mobile": [
            { path: "apps/mobile/AndroidManifest.xml", type: "blob", sha: blob("apps/mobile/AndroidManifest.xml"), size: 39 },
            { path: "apps/mobile/build.gradle", type: "blob", sha: blob("apps/mobile/build.gradle"), size: 13 },
            { path: "apps/mobile/MainActivity.kt", type: "blob", sha: blob("apps/mobile/MainActivity.kt"), size: 22 },
          ],
        } as Record<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>;
        return { entries: entries[path] ?? [], truncated: false };
      },
      async fetchBlob(_ref, path) {
        return new TextEncoder().encode(files.get(path)!);
      },
    };

    const go = await planner.plan({
      product: { id: 1, slug: "api", name: "API" },
      repository: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [{ path: "services/api", role: "api" }],
      budgets,
      plannerVersion: "v1",
      profileVersion: "v1",
    }, await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, { scopeRoots: [{ path: "services/api" }], backend }));
    expect(go.slice?.metrics.profileMatches[0]?.profileId).toBe("go-api");

    const android = await planner.plan({
      product: { id: 2, slug: "mobile", name: "Mobile" },
      repository: { owner: "gzhanlei", repo: "commerce", revision },
      scopeRoots: [{ path: "apps/mobile" }],
      budgets,
      plannerVersion: "v1",
      profileVersion: "v1",
    }, await createRemoteSourceIndex({ owner: "gzhanlei", repo: "commerce", revision }, { scopeRoots: [{ path: "apps/mobile" }], backend }));
    expect(android.slice?.metrics.profileMatches[0]?.profileId).toBe("android-native");
  });

  it("gates targeted reads and records approved evidence", () => {
    const planner = createSlicePlanner();
    const state: SlicePlanningState = {
      input: {
        product: { id: 1, slug: "checkout", name: "Checkout" },
        repository: { owner: "gzhanlei", repo: "commerce", revision },
        scopeRoots: [{ path: "apps/checkout" }],
        budgets: { maxSelectedFiles: 10, maxSelectedLineRanges: 100, maxPlannerContentBytes: 10_000, maxAiContextSourceBytes: 10_000, maxAiReadCalls: 1, maxComponents: 12, maxConnections: 24, maxRepairRounds: 2 },
        plannerVersion: "v1",
        profileVersion: "v1",
      },
      revision: {} as SlicePlanningState["revision"],
      phase: "targeted_exploration" as SlicePlanningState["phase"],
      scope: { status: "resolved", scopeRoots: [{ path: "apps/checkout" }] },
      selected: new Map(),
      fileContents: new Map(),
      evidenceClaims: [],
      questions: [],
      profileMatches: [],
      unresolved: [],
      diagnostics: [],
      budgetsRemaining: { selectedFiles: 10, selectedLineRanges: 100, plannerContentBytes: 10_000, aiReadCalls: 1, startedAt: Date.now() },
    };
    expect(planner.evaluateTargetedRead(state, { path: "outside.ts", startLine: 1, endLine: 1, requestedBy: "ai_explorer", reason: "outside" }).allowed).toBe(false);
    expect(planner.evaluateTargetedRead(state, { path: "apps/checkout/file.ts", startLine: 0, endLine: 1, requestedBy: "ai_explorer", reason: "invalid" }).allowed).toBe(false);
    const decision = planner.evaluateTargetedRead(state, { path: "apps/checkout/file.ts", startLine: 1, endLine: 2, requestedBy: "ai_explorer", reason: "verify edge" });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    const updated = planner.applyTargetedRead(state, decision.approval, {
      path: "apps/checkout/file.ts", blobSha: "blob", treeEntrySha: "blob", startLine: 1, endLine: 2, lines: ["a", "b"], byteSize: 4, lineCount: 2, verified: true, cacheState: "fetched", readReceipt: { requestedBy: "ai_explorer", reason: "verify edge", fetchedAt: "now" },
    });
    expect(updated.selected.get("apps/checkout/file.ts")?.reason).toBe("ai_targeted");
    expect(updated.evidenceClaims).toHaveLength(1);
    expect(updated.budgetsRemaining.aiReadCalls).toBe(0);
  });
});
