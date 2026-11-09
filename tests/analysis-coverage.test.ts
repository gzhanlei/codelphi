import { describe, expect, it } from "vitest";
import { computeCoverageReceipt, enumerateImplementationSurface, isCoverageCapped } from "../lib/analysis-coverage";
import type { OpenedRemoteSourceRevision, SourceTreeListing } from "../lib/remote-source-index";

const entry = (path: string, size: number, type: "blob" | "tree" = "blob") => ({ path, type, sha: path, size: type === "blob" ? size : undefined });

function fakeIndex(files: Array<{ path: string; size: number }>): OpenedRemoteSourceRevision {
  const dirs = new Set(files.map((file) => file.path.split("/").slice(0, -1).join("/")).filter(Boolean));
  const listing = (path: string): SourceTreeListing => ({
    path,
    truncated: false,
    status: "indexed" as const,
    metrics: { entryCount: 0, prunedCount: 0 },
    entries: [
      ...files.filter((file) => file.path.split("/").slice(0, -1).join("/") === path).map((file) => entry(file.path, file.size)),
      ...[...dirs].filter((dir) => dir.split("/").slice(0, -1).join("/") === path).map((dir) => entry(dir, 0, "tree")),
    ],
  });
  return {
    identity: {} as OpenedRemoteSourceRevision["identity"],
    scopeRoots: [],
    metrics: { treeExpansions: 0, blobFetches: 0, contentBytes: 0 },
    listRoot: async () => listing(""),
    listDir: async (path: string) => listing(path),
    expandPath: async () => listing(""),
    statPath: async () => null,
    readLines: async () => { throw new Error("not used"); },
    materializeEvidenceRoot: async () => { throw new Error("not used"); },
  };
}

const partition = (paths: Array<{ path: string; content: string }>) => ({
  slice: { files: paths.map((file) => ({ path: file.path })) },
  sources: paths,
});

describe("computeCoverageReceipt", () => {
  it("computes the assembled-vs-total implementation surface in the measure-script dialect", async () => {
    // 全树：3 个实现文件（lib/a.ts, lib/b.ts, app/c.tsx）+ 1 个测试 + 1 个文档（不算实现面）
    const index = fakeIndex([
      { path: "lib/a.ts", size: 4000 },
      { path: "lib/b.ts", size: 6000 },
      { path: "app/c.tsx", size: 10_000 },
      { path: "tests/a.test.ts", size: 2000 },
      { path: "README.md", size: 1000 },
    ]);
    const receipt = computeCoverageReceipt({
      index,
      partitions: [partition([{ path: "lib/a.ts", content: "x".repeat(3000) }]), partition([{ path: "lib/b.ts", content: "y".repeat(5000) }])],
      maxPartitions: 6,
      implSurface: await enumerateImplementationSurface(index),
    });
    expect(receipt.implFilesTotal).toBe(3);
    expect(receipt.implFilesAssembled).toBe(2);
    expect(receipt.implBytesTotal).toBe(20_000);
    expect(receipt.implBytesAssembled).toBe(8000);
    expect(receipt.partitionsUsed).toBe(2);
    expect(receipt.partitionsCapped).toBe(false);
  });

  it("deduplicates paths shared across partitions before summing", () => {
    const index = fakeIndex([{ path: "lib/a.ts", size: 4000 }, { path: "lib/b.ts", size: 6000 }]);
    const shared = partition([{ path: "lib/a.ts", content: "x".repeat(3000) }]);
    const receipt = computeCoverageReceipt({ index, partitions: [shared, partition([{ path: "lib/b.ts", content: "y" }]), shared], maxPartitions: 6 });
    expect(receipt.implFilesAssembled).toBe(2);
  });

  it("flags the partition cap when the last pass is not exhausted", async () => {
    // 趟数 = 上限 → 可能触顶（规划器耗尽时趟数恰好等于上限也会误报，故以「计划还有下一趟」为准，
    // 这里用 capped = 趟数达到上限 且 最后一趟仍有新增文件 近似；isCoverageCapped 语义由实现定义）
    const index = fakeIndex([
      { path: "lib/a.ts", size: 1000 },
      { path: "lib/b.ts", size: 1000 },
      { path: "lib/c.ts", size: 1000 },
    ]);
    const receipt = computeCoverageReceipt({
      index,
      partitions: [partition([{ path: "lib/a.ts", content: "x" }]), partition([{ path: "lib/b.ts", content: "x" }])],
      maxPartitions: 2,
      implSurface: await enumerateImplementationSurface(index),
    });
    expect(receipt.partitionsUsed).toBe(2);
    expect(isCoverageCapped(receipt, 2)).toBe(true);
  });

  it("reports zero coverage honestly when nothing was assembled", () => {
    const index = fakeIndex([{ path: "lib/a.ts", size: 4000 }]);
    const receipt = computeCoverageReceipt({ index, partitions: [], maxPartitions: 6 });
    expect(receipt.implFilesAssembled).toBe(0);
    expect(receipt.coverageRatio).toBe(0);
  });
});
