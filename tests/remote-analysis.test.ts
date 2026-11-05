import { describe, expect, it, vi } from "vitest";
import { getRemoteAnalysisSources, loadAIVlogArchitectureSources, loadRadarArchitectureSources, parseSourceRoots, sliceToSourceFiles } from "../lib/remote-analysis";
import { gitBlobSha, type OpenedRemoteSourceRevision, type RemoteSourceBackend, type SourceLineRequest, type SourceLineSlice, type SourceRevisionRef } from "../lib/remote-source-index";
import { analysisSliceBudgets } from "../lib/remote-analysis";
import { createSlicePlanner, type SlicePlanner } from "../lib/slice-planner";

const revision = "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937";

describe("remote analysis adapter", () => {
  it("parses configured source roots", () => {
    expect(parseSourceRoots(null)).toEqual([]);
    expect(parseSourceRoots(["apps/web", "services/api"])).toEqual([{ path: "apps/web" }, { path: "services/api" }]);
    expect(parseSourceRoots([{ path: "apps/web", role: "web" }])).toEqual([{ path: "apps/web", role: "web" }]);
    expect(() => parseSourceRoots([{}])).toThrow("Product source roots");
  });

  it("rebuilds numbered analysis sources from selected line ranges", async () => {
    const index = {
      async readLines(request: SourceLineRequest): Promise<SourceLineSlice> {
        const lines = request.path.endsWith("server.ts") ? ["const server = 1;", "start(server);"] : ["export default {};"];
        const selected = lines.slice(request.startLine - 1, request.endLine);
        return {
          path: request.path,
          blobSha: "blob",
          treeEntrySha: "blob",
          startLine: request.startLine,
          endLine: request.endLine,
          lines: selected,
          byteSize: selected.join("\n").length,
          lineCount: lines.length,
          verified: true,
          cacheState: "cached",
          readReceipt: { requestedBy: request.requestedBy, reason: request.reason, fetchedAt: "2026-11-03T00:00:00.000Z" },
        };
      },
    } as OpenedRemoteSourceRevision;
    const sources = await sliceToSourceFiles({
      product: { id: 1, slug: "checkout", name: "Checkout" },
      repository: "gzhanlei/commerce",
      revision: "sha",
      scopeRoots: [{ path: "apps/checkout" }],
      files: [
        { path: "apps/checkout/app/page.tsx", blobSha: "blob", treeEntrySha: "blob", reason: "entrypoint", byteSize: 20, lineRanges: [{ startLine: 1, endLine: 1, purpose: "entrypoint" }], signals: ["entrypoint"] },
        { path: "apps/checkout/src/server.ts", blobSha: "blob", treeEntrySha: "blob", reason: "entrypoint", byteSize: 40, lineRanges: [{ startLine: 1, endLine: 2, purpose: "entrypoint" }], signals: ["entrypoint"] },
      ],
      evidenceClaims: [],
      plannerVersion: "v1",
      profileVersion: "v1",
      confidence: "high",
      unresolved: [],
      metrics: {
        treeExpansions: 0, blobFetches: 0, selectedFiles: 2, selectedLineRanges: 3, selectedContentBytes: 60, aiReadCalls: 0, prunedPathCount: 0, wallClockMs: 0, profileMatches: [],
        budgetsRemaining: { selectedFiles: 0, selectedLineRanges: 0, plannerContentBytes: 0, aiReadCalls: 0 },
      },
    }, index);
    expect(sources).toEqual([
      { path: "apps/checkout/app/page.tsx", content: "1: export default {};" },
      { path: "apps/checkout/src/server.ts", content: "1: const server = 1;\n2: start(server);" },
    ]);
  });

  it("loads complete Radar architecture evidence independently of the AI slice", async () => {
    const readLines = vi.fn(async (request: SourceLineRequest) => ({
      path: request.path,
      blobSha: "blob",
      treeEntrySha: "blob",
      startLine: 1,
      endLine: 2,
      lines: [`${request.path} marker`, "second line"],
      byteSize: 30,
      lineCount: 2,
      verified: true as const,
      cacheState: "fetched" as const,
      readReceipt: { requestedBy: request.requestedBy, reason: request.reason, fetchedAt: "2026-11-04T00:00:00.000Z" },
    }));
    const result = await loadRadarArchitectureSources({ readLines } as unknown as OpenedRemoteSourceRevision, [
      { path: "lib/db.ts", content: "1: truncated" },
      { path: "custom/source.ts", content: "1: preserved" },
    ]);
    expect(result.find((source) => source.path === "lib/db.ts")?.content).toBe("1: lib/db.ts marker\n2: second line");
    expect(result.find((source) => source.path === "custom/source.ts")?.content).toBe("1: preserved");
    expect(result.some((source) => source.path === "lib/analysis.ts")).toBe(true);
    expect(result.some((source) => source.path === "lib/ai.ts")).toBe(true);
    expect(readLines).toHaveBeenCalledWith(expect.objectContaining({ path: "lib/db.ts", startLine: 1, endLine: 600, requestedBy: "evidence_verifier" }));
  });

  it("loads complete AIVlog architecture evidence independently of the AI slice", async () => {
    const readLines = vi.fn(async (request: SourceLineRequest) => ({
      path: request.path,
      blobSha: "blob",
      treeEntrySha: "blob",
      startLine: 1,
      endLine: 2,
      lines: [`${request.path} marker`, "second line"],
      byteSize: 30,
      lineCount: 2,
      verified: true as const,
      cacheState: "fetched" as const,
      readReceipt: { requestedBy: request.requestedBy, reason: request.reason, fetchedAt: "2026-11-04T00:00:00.000Z" },
    }));
    const result = await loadAIVlogArchitectureSources({ readLines } as unknown as OpenedRemoteSourceRevision, [
      { path: "miniprogram/utils/cloud.js", content: "1: truncated" },
      { path: "custom/source.ts", content: "1: preserved" },
    ]);
    expect(result.find((source) => source.path === "miniprogram/utils/cloud.js")?.content).toBe("1: miniprogram/utils/cloud.js marker\n2: second line");
    expect(result.find((source) => source.path === "custom/source.ts")?.content).toBe("1: preserved");
    expect(result.some((source) => source.path === "backend/cmd/remoteagent/main.go")).toBe(true);
    expect(result.some((source) => source.path === "backend/internal/worker/runner.go")).toBe(true);
    expect(readLines).toHaveBeenCalledWith(expect.objectContaining({ path: "miniprogram/utils/cloud.js", startLine: 1, endLine: 600, requestedBy: "evidence_verifier" }));
  });

  it("rejects empty configured source roots", () => {
    expect(() => parseSourceRoots([""])).toThrow("Product source roots");
    expect(() => parseSourceRoots([{ path: "" }])).toThrow("Product source roots");
  });

  it("reports an unknown planner failure when diagnostics are absent", async () => {
    const files = new Map([["apps/checkout/package.json", "{}\n"]]);
    const sha = gitBlobSha(files.get("apps/checkout/package.json")!);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        if (!path) return { entries: [{ path: "apps", type: "tree", sha: "tree-apps" }], truncated: false };
        if (path === "apps") return { entries: [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }], truncated: false };
        return { entries: [{ path: "apps/checkout/package.json", type: "blob", sha, size: 3 }], truncated: false };
      },
      async fetchBlob(_source, path) {
        return new TextEncoder().encode(files.get(path)!);
      },
    };
    const planner: SlicePlanner = {
      resolveScope: async () => ({ status: "resolved", unresolved: [], scopeRoots: [{ path: "apps/checkout" }] }),
      plan: async () => ({ status: "failed", missing: [], diagnostics: [] }),
      evaluateTargetedRead: () => { throw new Error("unused"); },
      applyTargetedRead: (state) => state,
      finalize: async () => ({ status: "failed", missing: [], diagnostics: [] }),
    };
    await expect(getRemoteAnalysisSources({
      product: { id: 1, slug: "checkout", name: "Checkout" },
      repository: { owner: "gzhanlei", repo: "commerce", revision: revision },
      access: { token: "token" },
      scopeRoots: [{ path: "apps/checkout" }],
      backend,
    }, { planner, budgets: analysisSliceBudgets })).rejects.toThrow("Remote source slice failed: unknown planner failure");
  });

  it("rejects a planner slice with no selected source files", async () => {
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree() {
        return { entries: [], truncated: false };
      },
      async fetchBlob() {
        return new TextEncoder().encode("{}");
      },
    };
    const planner: SlicePlanner = {
      resolveScope: async () => ({ status: "resolved", unresolved: [], scopeRoots: [{ path: "apps/checkout" }] }),
      plan: async () => ({
        status: "underdetermined",
        missing: [],
        diagnostics: [],
        slice: {
          product: { id: 1, slug: "checkout", name: "Checkout" },
          repository: "gzhanlei/commerce",
          revision,
          scopeRoots: [{ path: "apps/checkout" }],
          files: [],
          evidenceClaims: [],
          plannerVersion: "v1",
          profileVersion: "v1",
          confidence: "low",
          unresolved: [],
          metrics: {
            treeExpansions: 0,
            blobFetches: 0,
            selectedFiles: 0,
            selectedLineRanges: 0,
            selectedContentBytes: 0,
            aiReadCalls: 0,
            prunedPathCount: 0,
            wallClockMs: 0,
            profileMatches: [],
            budgetsRemaining: { selectedFiles: 0, selectedLineRanges: 0, plannerContentBytes: 0, aiReadCalls: 0 },
          },
        },
      }),
      evaluateTargetedRead: () => { throw new Error("unused"); },
      applyTargetedRead: (state) => state,
      finalize: async () => ({ status: "failed", missing: [], diagnostics: [] }),
    };
    await expect(getRemoteAnalysisSources({
      product: { id: 1, slug: "checkout", name: "Checkout" },
      repository: { owner: "gzhanlei", repo: "commerce", revision: revision },
      access: { token: "token" },
      scopeRoots: [{ path: "apps/checkout" }],
      backend,
    }, { planner, budgets: analysisSliceBudgets })).rejects.toThrow("No supported source files found");
  });

  it("plans and returns numbered sources through the remote index", async () => {
    const ref: SourceRevisionRef = { owner: "gzhanlei", repo: "commerce", revision: "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937" };
    const files = new Map([
      ["apps/checkout/package.json", JSON.stringify({ dependencies: { next: "16.0.0", express: "4.0.0" } })],
      ["apps/checkout/app/page.tsx", "export default function Page() {}\n"],
      ["apps/checkout/src/server.ts", "const server = 1;\nstart(server);\n"],
    ]);
    const sha = (path: string) => gitBlobSha(files.get(path)!);
    const trees = new Map<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>([
      ["", [{ path: "apps", type: "tree", sha: "tree-apps" }]],
      ["apps", [{ path: "apps/checkout", type: "tree", sha: "tree-checkout" }]],
      ["apps/checkout", [
        { path: "apps/checkout/package.json", type: "blob", sha: sha("apps/checkout/package.json"), size: 70 },
        { path: "apps/checkout/app", type: "tree", sha: "tree-app" },
        { path: "apps/checkout/src", type: "tree", sha: "tree-src" },
      ]],
      ["apps/checkout/app", [{ path: "apps/checkout/app/page.tsx", type: "blob", sha: sha("apps/checkout/app/page.tsx"), size: 35 }]],
      ["apps/checkout/src", [{ path: "apps/checkout/src/server.ts", type: "blob", sha: sha("apps/checkout/src/server.ts"), size: 35 }]],
    ]);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        return { entries: trees.get(path) ?? [], truncated: false };
      },
      async fetchBlob(_source, path) {
        return new TextEncoder().encode(files.get(path)!);
      },
    };
    const result = await getRemoteAnalysisSources({
      product: { id: 7, slug: "checkout", name: "Checkout" },
      repository: { owner: ref.owner, repo: ref.repo, revision: ref.revision },
      access: { token: "test-token" },
      scopeRoots: [{ path: "apps/checkout", role: "web" }],
      backend,
    }, {
      planner: createSlicePlanner({ now: Date.now }),
      budgets: analysisSliceBudgets,
    });
    expect(result.sources.map((source) => source.path)).toEqual([
      "apps/checkout/package.json",
      "apps/checkout/app/page.tsx",
      "apps/checkout/src/server.ts",
    ]);
    expect(result.sources[0].content).toContain("1: {");
    expect(result.sources[1].content).toBe("1: export default function Page() {}");
    expect(result.sources[2].content).toBe("1: const server = 1;\n2: start(server);");
    expect(result.slice.confidence).toBe("high");
    expect(result.index.metrics.blobFetches).toBeGreaterThan(0);
    const architectureIndex = await result.openArchitectureIndex();
    expect(architectureIndex).not.toBe(result.index);
    expect(architectureIndex.identity.revision).toBe(ref.revision);
    expect(architectureIndex.metrics).toEqual({ treeExpansions: 0, blobFetches: 0, contentBytes: 0 });
  });
});
