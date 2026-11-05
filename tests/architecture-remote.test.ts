import { describe, expect, it } from "vitest";
import { architectureSourceIndexBudgets, loadArchitectureRepositorySources } from "../lib/architecture/remote";
import type { OpenedRemoteSourceRevision, SourceLineRequest, SourceTreeListing } from "../lib/remote-source-index";

function listing(path: string, entries: SourceTreeListing["entries"], truncated = false): SourceTreeListing {
  return { path, entries, truncated, status: truncated ? "partial" : "indexed", metrics: { entryCount: entries.length, prunedCount: 0 } };
}

function blob(path: string): SourceTreeListing["entries"][number] {
  return { path, parentPath: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", type: "blob", sha: `sha-${path}`, signals: [] };
}

function tree(path: string): SourceTreeListing["entries"][number] {
  return { ...blob(path), type: "tree" };
}

function fixtureIndex(files: Map<string, string>, truncated = false, inconsistent = false, pageLimit = 600) {
  const reads: SourceLineRequest[] = [];
  const listPaths: string[] = [];
  const index = {
    async listDir(path: string) {
      listPaths.push(path);
      if (path === "") {
        const root = listing("", [tree("cmd"), blob("README.md"), blob("package.json"), blob("image.png")], truncated);
        return inconsistent ? { ...root, status: "indexed" as const } : root;
      }
      if (path === "cmd") return listing("cmd", [blob("cmd/main.go")]);
      return listing(path, []);
    },
    async readLines(request: SourceLineRequest) {
      reads.push(request);
      const lines = (files.get(request.path) ?? "").split("\n");
      const selected = lines.slice(request.startLine - 1, Math.min(request.endLine, request.startLine + pageLimit - 1));
      return {
        path: request.path,
        blobSha: `sha-${request.path}`,
        treeEntrySha: `sha-${request.path}`,
        startLine: request.startLine,
        endLine: Math.min(request.endLine, request.startLine + pageLimit - 1, lines.length),
        lines: selected,
        byteSize: selected.join("\n").length,
        lineCount: lines.length,
        verified: true as const,
        cacheState: "fetched" as const,
        readReceipt: { requestedBy: request.requestedBy, reason: request.reason, fetchedAt: "now" },
      };
    },
  } as unknown as OpenedRemoteSourceRevision;
  return { index, reads, listPaths };
}

describe("architecture repository source loading", () => {
  it("uses independent bounded budgets for repository-scale architecture reads", () => {
    expect(architectureSourceIndexBudgets).toEqual({ maxTreeExpansions: 1000, maxBlobFetches: 1000, maxBlobBytes: 1_000_000, maxLinesPerRead: 600, maxTotalContentBytes: 10_000_000 });
  });

  it("reads complete fixed-revision source files in pages and ignores non-runtime assets", async () => {
    const goLines = Array.from({ length: 601 }, (_, index) => `line-${index + 1}`).join("\n");
    const expectedBytes = goLines.length + 1;
    const { index, reads } = fixtureIndex(new Map([["cmd/main.go", goLines], ["package.json", "{}"]]));
    const result = await loadArchitectureRepositorySources(index, [{ path: "" }], { maxFiles: 2, maxDirectories: 10, maxTotalBytes: expectedBytes });
    expect(result.sources.map((source) => source.path)).toEqual(["cmd/main.go", "package.json"]);
    expect(result.sources[0].content).toContain("1: line-1");
    expect(result.sources[0].content.split("\n")[1]).toBe("2: line-2");
    expect(result.sources[0].content).toContain("601: line-601");
    expect(reads.filter((read) => read.path === "cmd/main.go").map((read) => read.startLine)).toEqual([1, 601]);
    expect(result.receipt).toEqual({ scope: "repository", directories: 2, files: 2, bytes: expectedBytes });
  });

  it("continues after a one-line non-final page", async () => {
    const { index, reads } = fixtureIndex(new Map([["cmd/main.go", "first\nsecond\nthird"]]), false, false, 1);
    const result = await loadArchitectureRepositorySources(index, [{ path: "cmd" }]);
    expect(result.sources[0].content).toBe("1: first\n2: second\n3: third");
    expect(reads.map((read) => read.startLine)).toEqual([1, 2, 3]);
  });

  it("fails closed for incomplete trees and explicit source budgets", async () => {
    const truncated = fixtureIndex(new Map(), true);
    await expect(loadArchitectureRepositorySources(truncated.index, [{ path: "" }])).rejects.toThrow("Architecture source tree incomplete");
    const mismatched = fixtureIndex(new Map(), true, true);
    await expect(loadArchitectureRepositorySources(mismatched.index, [{ path: "" }])).rejects.toThrow("Architecture source tree incomplete");
    const files = fixtureIndex(new Map([["package.json", "{}"]]));
    await expect(loadArchitectureRepositorySources(files.index, [{ path: "" }], { maxFiles: 0, maxDirectories: 10, maxTotalBytes: 1000 })).rejects.toThrow("Architecture source file budget exhausted");
    const noDirectories = fixtureIndex(new Map([["package.json", "{}"]]));
    await expect(loadArchitectureRepositorySources(noDirectories.index, [{ path: "" }], { maxFiles: 10, maxDirectories: 0, maxTotalBytes: 1000 })).rejects.toThrow("Architecture source directory budget exhausted");
    expect(noDirectories.listPaths).toEqual([]);
  });
});
