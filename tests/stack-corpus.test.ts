import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { architectureSummary, parseStackCorpusArgs, runStackCorpus, selectStackCorpusRepositories, type StackCorpusManifest } from "../scripts/stack-corpus";
import { gitBlobSha, type OpenedRemoteSourceRevision, type RemoteSourceBackend } from "../lib/remote-source-index";
import type { SlicePlanner } from "../lib/slice-planner";

const manifest: StackCorpusManifest = {
  version: 1,
  updatedAt: "2026-11-03",
  repositories: [
    { id: "go-api", owner: "gzhanlei", repo: "go-api", revision: "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937", expectedProfile: "go-api", sourceRoots: [""] },
    { id: "web", owner: "gzhanlei", repo: "web", revision: "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937", expectedProfile: "next-web", sourceRoots: [""] },
  ],
};

function backend(files: Map<string, string>): RemoteSourceBackend {
  const sha = (path: string) => gitBlobSha(files.get(path)!);
  return {
    kind: "github_api",
    async resolveRevision() {
      return { rootTreeSha: "tree-root" };
    },
    async listTree(_ref, _treeSha, path) {
      const entries: Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }> = path === "" ? [{ path: "go.mod", type: "blob", sha: sha("go.mod"), size: 15 }] : [];
      return { entries, truncated: false };
    },
    async fetchBlob(_ref, path) {
      return new TextEncoder().encode(files.get(path)!);
    },
  };
}

describe("stack corpus runner", () => {
  it("parses CLI arguments", () => {
    expect(parseStackCorpusArgs([])).toEqual({ only: [], output: "artifacts/stack-corpus/report.json" });
    expect(parseStackCorpusArgs(["--only=go-api,web", "--output=/tmp/report.json"])).toEqual({ only: ["go-api", "web"], output: "/tmp/report.json" });
  });

  it("selects requested repositories by id or full name", () => {
    expect(selectStackCorpusRepositories(manifest, []).map((repo) => repo.id)).toEqual(["go-api", "web"]);
    expect(selectStackCorpusRepositories(manifest, ["go-api"]).map((repo) => repo.id)).toEqual(["go-api"]);
    expect(selectStackCorpusRepositories(manifest, ["gzhanlei/web"]).map((repo) => repo.id)).toEqual(["web"]);
  });

  it("analyzes a planner slice and writes successful architecture metadata", async () => {
    const files = new Map([
      ["package.json", "{\n  \"dependencies\": {\"next\": \"1\"}\n}\n"],
      ["app/page.tsx", "export default function Page() {}\n"],
      ["internal/api.go", "func Handler() {}\n"],
    ]);
    const sha = (file: string) => gitBlobSha(files.get(file)!);
    const index = {
      identity: { repository: "gzhanlei/go-api", revision: "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937", rootTreeSha: "root", backend: "github_api", status: "indexed" },
      scopeRoots: [{ path: "" }],
      metrics: { treeExpansions: 1, blobFetches: 3, contentBytes: 100 },
      listRoot: async () => ({ path: "", entries: [], truncated: false, status: "indexed", metrics: { entryCount: 0, prunedCount: 0 } }),
      listDir: async () => ({ path: "", entries: [], truncated: false, status: "indexed", metrics: { entryCount: 0, prunedCount: 0 } }),
      expandPath: async () => ({ path: "", entries: [], truncated: false, status: "indexed", metrics: { entryCount: 0, prunedCount: 0 } }),
      statPath: async () => null,
      readLines: async ({ path, startLine, endLine }: { path: string; startLine: number; endLine: number }) => {
        const lines = files.get(path)!.replace(/\n$/, "").split("\n").slice(startLine - 1, endLine);
        return {
          path, blobSha: sha(path), treeEntrySha: sha(path), startLine, endLine, lines, byteSize: lines.join("\n").length, lineCount: lines.length,
          verified: true, cacheState: "fetched", readReceipt: { requestedBy: "evidence_verifier", reason: "test", fetchedAt: "now" },
        };
      },
      materializeEvidenceRoot: async () => ({ rootPath: "", kind: "materialized_files", fileCount: 0, byteSize: 0, verified: true, missingPaths: [] }),
    } as unknown as OpenedRemoteSourceRevision;
    const planner: SlicePlanner = {
      resolveScope: async () => ({ status: "resolved", unresolved: [], scopeRoots: [{ path: "" }] }),
      plan: async () => ({
        status: "completed",
        missing: [],
        diagnostics: [],
        slice: {
          product: { id: 0, slug: "go-api", name: "go-api" },
          repository: "gzhanlei/go-api",
          revision: "9f31c0de7a41b8d2e5f60a93c4d78ba12ef50937",
          scopeRoots: [{ path: "" }],
          files: [
            { path: "package.json", blobSha: sha("package.json"), treeEntrySha: sha("package.json"), reason: "manifest", byteSize: 42, lineRanges: [{ startLine: 1, endLine: 4, purpose: "manifest" }], signals: ["manifest"] },
            { path: "app/page.tsx", blobSha: sha("app/page.tsx"), treeEntrySha: sha("app/page.tsx"), reason: "entrypoint", byteSize: 40, lineRanges: [{ startLine: 1, endLine: 1, purpose: "entrypoint" }], signals: ["entrypoint", "frontend"] },
            { path: "internal/api.go", blobSha: sha("internal/api.go"), treeEntrySha: sha("internal/api.go"), reason: "service", byteSize: 20, lineRanges: [{ startLine: 1, endLine: 1, purpose: "service" }], signals: ["service"] },
          ],
          evidenceClaims: [],
          plannerVersion: "test",
          profileVersion: "test",
          confidence: "high",
          unresolved: [],
          metrics: {
            treeExpansions: 1, blobFetches: 3, selectedFiles: 3, selectedLineRanges: 3, selectedContentBytes: 102, aiReadCalls: 0, prunedPathCount: 0, wallClockMs: 0, profileMatches: [],
            budgetsRemaining: { selectedFiles: 0, selectedLineRanges: 0, plannerContentBytes: 0, aiReadCalls: 0 },
          },
        },
      }),
      evaluateTargetedRead: () => { throw new Error("unused"); },
      applyTargetedRead: (state) => state,
      finalize: async () => ({ status: "completed", missing: [], diagnostics: [] }),
    };
    const root = await mkdtemp(path.join(tmpdir(), "stack-corpus-success-"));
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const report = await runStackCorpus({
      only: ["go-api"], output: "report.json", manifestPath, planner,
      index, token: "test-token", root,
    });
    expect(report.summary.completed).toBe(1);
    const result = (report.results as unknown as Array<{ architectureComponents: string[]; architectureError: string | null }>)[0];
    expect(result.architectureComponents).toEqual(expect.arrayContaining(["users", "frontend", "backend"]));
    expect(result.architectureError).toBeNull();
  });

  it("summarizes successful and failed architecture generation", () => {
    const repository = manifest.repositories[0];
    const success = architectureSummary(repository, repository.revision, [
      { path: "package.json", content: "1: {}" },
      { path: "app/page.tsx", content: "1: export default function Page() {}" },
      { path: "internal/api.go", content: "1: func Handler() {}" },
    ]);
    expect(success.architectureError).toBeNull();
    expect(success.architectureComponents).toEqual(expect.arrayContaining(["users", "frontend", "backend"]));
    const failed = architectureSummary(repository, repository.revision, [{ path: "package.json", content: "1: unrelated" }]);
    expect(failed.architectureComponents).toEqual([]);
    expect(failed.architectureError).toBe("No architecture components detected");
  });

  it("throws when no repositories are selected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "stack-corpus-empty-"));
    await expect(runStackCorpus({
      only: ["not-present"], output: "report.json", manifestPath: path.join(process.cwd(), "tests/fixtures/stack-corpus/manifest.json"),
      planner: { resolveScope: async () => ({ status: "resolved", unresolved: [], scopeRoots: [] }), plan: async () => ({ status: "failed", missing: [], diagnostics: [] }), evaluateTargetedRead: () => { throw new Error("unused"); }, applyTargetedRead: (state) => state, finalize: async () => ({ status: "failed", missing: [], diagnostics: [] }) },
      token: "token", root,
    })).rejects.toThrow("No stack corpus repositories selected");
  });

  it("writes a planner report without calling AI", async () => {
    const planner: SlicePlanner = {
      resolveScope: async () => ({ status: "resolved", unresolved: [], scopeRoots: [{ path: "" }] }),
      plan: async () => ({ status: "failed", missing: ["test planner stopped"], diagnostics: [] }),
      evaluateTargetedRead: () => { throw new Error("unused"); },
      applyTargetedRead: (state) => state,
      finalize: async () => ({ status: "failed", missing: [], diagnostics: [] }),
    };
    const root = await mkdtemp(path.join(tmpdir(), "stack-corpus-"));
    const manifestPath = path.join(root, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const report = await runStackCorpus({
      only: ["go-api"],
      output: "report.json",
      manifestPath,
      planner,
      index: {
        listDir: async () => ({ path: "", entries: [], truncated: false, status: "indexed", metrics: { entryCount: 0, prunedCount: 0 } }),
      } as unknown as OpenedRemoteSourceRevision,
      token: "test-token",
      root,
    });
    expect(report.summary.total).toBe(1);
    expect(report.summary.completed).toBe(0);
    const saved = JSON.parse(await readFile(path.join(root, "report.json"), "utf8"));
    expect(saved.results[0].error).toBe("test planner stopped");
  });
});
