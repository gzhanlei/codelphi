import { describe, expect, it } from "vitest";
import { getRemoteAnalysisSources, parseSourceRoots, sliceToSourceFiles } from "../lib/remote-analysis";
import { gitBlobSha, type OpenedRemoteSourceRevision, type RemoteSourceBackend, type SourceLineRequest, type SourceLineSlice, type SourceRevisionRef } from "../lib/remote-source-index";

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
  });
});
