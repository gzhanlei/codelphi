import { describe, expect, it } from "vitest";
import { createRemoteSourceIndex, gitBlobSha, type RemoteSourceBackend, type SourceRevisionRef, type SourceScopeRoot, type SourceTreeApiEntry } from "../lib/remote-source-index";
import { createSlicePlanner, type SliceBudgets } from "../lib/slice-planner";

const ref: SourceRevisionRef = { owner: "gzhanlei", repo: "commerce", revision: "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937" };
const baseBudgets: SliceBudgets = {
  maxSelectedFiles: 50,
  maxSelectedLineRanges: 600,
  maxPlannerContentBytes: 500_000,
  maxAiContextSourceBytes: 500_000,
  maxAiReadCalls: 10,
  maxComponents: 12,
  maxConnections: 24,
  maxRepairRounds: 2,
};

function backendFrom(files: Map<string, string>, trees: Map<string, SourceTreeApiEntry[]>): RemoteSourceBackend {
  const sha = (path: string) => gitBlobSha(files.get(path)!);
  return {
    kind: "github_api",
    async resolveRevision() {
      return { rootTreeSha: "tree-root" };
    },
    async listTree(_source, _treeSha, path) {
      const entries = trees.get(path) ?? [];
      return {
        entries: entries.map((entry) => entry.type === "blob" ? { ...entry, sha: sha(entry.path), size: Buffer.byteLength(files.get(entry.path)!) } : entry),
        truncated: false,
      };
    },
    async fetchBlob(_source, path) {
      return new TextEncoder().encode(files.get(path)!);
    },
  };
}

describe("slice planner budget and traversal behavior", () => {
  it("selects priority candidates before ordinary files", async () => {
    const files = new Map([
      ["apps/mobile/helper.ts", "export const helper = 1;\n"],
      ["apps/mobile/raop.c", "void raop_init() {}\n"],
      ["apps/mobile/MainActivity.java", "class MainActivity {}\n"],
      ["apps/mobile/package.json", "{}\n"],
      ["apps/mobile/AndroidManifest.xml", "<manifest />\n"],
      ["apps/mobile/icon.png", "binary\n"],
    ]);
    const tree = (path: string) => ({ path, type: "tree" as const, sha: `tree-${path}` });
    const blob = (path: string) => ({ path, type: "blob" as const, sha: "filled-by-backend" });
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [tree("apps")]],
      ["apps", [tree("apps/mobile")]],
      ["apps/mobile", [blob("apps/mobile/helper.ts"), blob("apps/mobile/raop.c"), blob("apps/mobile/MainActivity.java"), blob("apps/mobile/package.json"), blob("apps/mobile/AndroidManifest.xml"), blob("apps/mobile/icon.png"), tree("apps/mobile/src")]],
    ]);
    const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/mobile" }], backend: backendFrom(files, trees) });
    const result = await createSlicePlanner({ now: () => 20 }).plan({
      product: { id: 1, slug: "mobile", name: "Mobile" },
      repository: ref,
      scopeRoots: [{ path: "apps/mobile" }],
      budgets: baseBudgets,
      plannerVersion: "v1",
      profileVersion: "v1",
    }, index);
    expect(result.status).toBe("completed");
    expect(result.diagnostics).toEqual([]);
    expect(result.slice?.files.map((file) => file.path)).toEqual([
      "apps/mobile/AndroidManifest.xml",
      "apps/mobile/package.json",
      "apps/mobile/MainActivity.java",
      "apps/mobile/raop.c",
    ]);
    expect(result.slice?.files.map((file) => file.reason)).toEqual(["manifest", "manifest", "entrypoint", "service"]);
    expect(result.status).toBe("completed");
    expect(result.slice?.metrics.profileMatches[0]?.profileId).toBe("android-native");
  });

  it("traverses to depth four but not depth five", async () => {
    const files = new Map([
      ["apps/api/go.mod", "module api\n"],
      ["apps/api/src/server.ts", "const server = 1;\n"],
      ["apps/api/src/domain/database.ts", "const db = 1;\n"],
      ["apps/api/src/domain/core/queue.ts", "const queue = 1;\n"],
      ["apps/api/src/domain/core/leaf/database.ts", "const database = 1;\n"],
    ]);
    const tree = (path: string) => ({ path, type: "tree" as const, sha: `tree-${path}` });
    const blob = (path: string) => ({ path, type: "blob" as const, sha: "filled-by-backend" });
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [tree("apps")]],
      ["apps", [tree("apps/api")]],
      ["apps/api", [blob("apps/api/go.mod"), tree("apps/api/src")]],
      ["apps/api/src", [blob("apps/api/src/server.ts"), tree("apps/api/src/domain")]],
      ["apps/api/src/domain", [blob("apps/api/src/domain/database.ts"), tree("apps/api/src/domain/core")]],
      ["apps/api/src/domain/core", [blob("apps/api/src/domain/core/queue.ts"), tree("apps/api/src/domain/core/leaf")]],
      ["apps/api/src/domain/core/leaf", [blob("apps/api/src/domain/core/leaf/database.ts"), tree("apps/api/src/domain/core/leaf/too-deep")]],
      ["apps/api/src/domain/core/leaf/too-deep", [blob("apps/api/src/domain/core/leaf/too-deep/excluded.ts"), tree("apps/api/src/domain/core/leaf/too-deep/deeper")]],
      ["apps/api/src/domain/core/leaf/too-deep/deeper", [blob("apps/api/src/domain/core/leaf/too-deep/deeper/excluded.ts")]],
    ]);
    const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "apps/api" }], backend: backendFrom(files, trees) });
    const result = await createSlicePlanner({ now: () => 30 }).plan({
      product: { id: 2, slug: "api", name: "API" },
      repository: ref,
      scopeRoots: [{ path: "apps/api" }],
      budgets: baseBudgets,
      plannerVersion: "v1",
      profileVersion: "v1",
    }, index);
    expect(result.status).toBe("completed");
    expect(result.slice?.files.map((file) => file.path)).toEqual([
      "apps/api/go.mod",
      "apps/api/src/server.ts",
      "apps/api/src/domain/database.ts",
      "apps/api/src/domain/core/queue.ts",
      "apps/api/src/domain/core/leaf/database.ts",
    ]);
    expect(result.slice?.files.some((file) => file.path.includes("too-deep"))).toBe(false);
  });

  it("stops at file, line-range, and byte budgets", async () => {
    const files = new Map([
      ["apps/api/go.mod", "module api\n"],
      ["apps/api/server.ts", "const server = 123;\n"],
      ["apps/api/database.ts", "const database = 12345;\n"],
    ]);
    const tree = (path: string) => ({ path, type: "tree" as const, sha: `tree-${path}` });
    const blob = (path: string) => ({ path, type: "blob" as const, sha: "filled-by-backend" });
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [tree("apps")]],
      ["apps", [tree("apps/api")]],
      ["apps/api", [blob("apps/api/go.mod"), blob("apps/api/server.ts"), blob("apps/api/database.ts")]],
    ]);
    const scopes: SourceScopeRoot[] = [{ path: "apps/api" }];

    const fileBudget = await createSlicePlanner({ now: () => 40 }).plan({
      product: { id: 3, slug: "api", name: "API" },
      repository: ref,
      scopeRoots: scopes,
      budgets: { ...baseBudgets, maxSelectedFiles: 2 },
      plannerVersion: "v1",
      profileVersion: "v1",
    }, await createRemoteSourceIndex(ref, { access: {}, scopeRoots: scopes, backend: backendFrom(files, trees) }));
    expect(fileBudget.slice?.files.map((file) => file.path)).toEqual(["apps/api/go.mod", "apps/api/server.ts"]);
    expect(fileBudget.slice?.metrics.budgetsRemaining).toEqual({
      selectedFiles: 0,
      selectedLineRanges: baseBudgets.maxSelectedLineRanges - 2,
      plannerContentBytes: baseBudgets.maxPlannerContentBytes - fileBudget.slice!.files.reduce((total, file) => total + file.byteSize, 0),
      aiReadCalls: 10,
    });

    const lineBudget = await createSlicePlanner({ now: () => 41 }).plan({
      product: { id: 4, slug: "api", name: "API" },
      repository: ref,
      scopeRoots: scopes,
      budgets: { ...baseBudgets, maxSelectedLineRanges: 2 },
      plannerVersion: "v1",
      profileVersion: "v1",
    }, await createRemoteSourceIndex(ref, { access: {}, scopeRoots: scopes, backend: backendFrom(files, trees) }));
    expect(lineBudget.slice?.files.map((file) => file.path)).toEqual(["apps/api/go.mod", "apps/api/server.ts"]);
    expect(lineBudget.slice?.files.map((file) => file.lineRanges)).toEqual([
      [{ startLine: 1, endLine: 1, purpose: "manifest" }],
      [{ startLine: 1, endLine: 1, purpose: "entrypoint" }],
    ]);

    const byteBudget = baseBudgets.maxPlannerContentBytes;
    const firstTwoBytes = fileBudget.slice!.files.reduce((total, file) => total + file.byteSize, 0);
    const byteLimited = await createSlicePlanner({ now: () => 42 }).plan({
      product: { id: 5, slug: "api", name: "API" },
      repository: ref,
      scopeRoots: scopes,
      budgets: { ...baseBudgets, maxPlannerContentBytes: firstTwoBytes },
      plannerVersion: "v1",
      profileVersion: "v1",
    }, await createRemoteSourceIndex(ref, { access: {}, scopeRoots: scopes, backend: backendFrom(files, trees) }));
    expect(byteLimited.slice?.files.map((file) => file.path)).toEqual(["apps/api/go.mod", "apps/api/server.ts"]);
    expect(byteLimited.slice?.metrics.budgetsRemaining.plannerContentBytes).toBe(0);
    expect(byteLimited.slice?.metrics.selectedContentBytes).toBe(firstTwoBytes);
    expect(byteBudget).toBeGreaterThan(firstTwoBytes);
  });

  it("returns the remaining valid scope root when another root is absent", async () => {
    const files = new Map([["apps/api/go.mod", "module api\n"]]);
    const tree = (path: string) => ({ path, type: "tree" as const, sha: `tree-${path}` });
    const blob = (path: string) => ({ path, type: "blob" as const, sha: "filled-by-backend" });
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [tree("apps")]],
      ["apps", [tree("apps/api")]],
      ["apps/api", [blob("apps/api/go.mod")]],
    ]);
    const scopes: SourceScopeRoot[] = [{ path: "apps/api" }, { path: "services/missing" }];
    const result = await createSlicePlanner({ now: () => 50 }).plan({
      product: { id: 6, slug: "api", name: "API" },
      repository: ref,
      scopeRoots: scopes,
      budgets: baseBudgets,
      plannerVersion: "v1",
      profileVersion: "v1",
    }, await createRemoteSourceIndex(ref, { access: {}, scopeRoots: scopes, backend: backendFrom(files, trees) }));
    expect(result.status).toBe("underdetermined");
    expect(result.missing).toEqual(["scope root does not exist: services/missing"]);
    expect(result.diagnostics[0]?.code).toBe("scope_root_not_found");
  });
});
