import { describe, expect, it, vi } from "vitest";
import { computeCoverageReceipt, enumerateImplementationSurface, isCoverageCapped, loadInheritedCoverageReceipt } from "../lib/analysis-coverage";
import type { AnalysisPartition, } from "../lib/remote-analysis";
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
  } as unknown as SourceTreeListing);
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

const partition = (paths: Array<{ path: string; content: string }>): AnalysisPartition => ({
  slice: { files: paths.map((file) => ({ path: file.path })) },
  sources: paths,
} as unknown as AnalysisPartition);

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

describe("loadInheritedCoverageReceipt (BM-10 修复：写侧继承与读侧同构沿链)", () => {
  const walkExecute = (chain: Array<{ id: number; receipt: Record<string, unknown> | null }>) =>
    vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM spec_versions WHERE repository_id")) {
        const before = Number(params?.[1]);
        // fake 须模拟 SQL 的 LIMIT 语义，否则「链走封顶」断言失真
        const limitMatch = /LIMIT (\d+)/.exec(sql);
        const limit = limitMatch ? Number(limitMatch[1]) : chain.length;
        return [chain.filter((item) => item.id < before).slice(0, limit).map((item) => ({ id: item.id }))];
      }
      const versionId = Number(params?.[0]);
      const found = chain.find((item) => item.id === versionId);
      return [found?.receipt ? [found.receipt] : []];
    });

  const realReceipt = { implFilesAssembled: 12, implFilesTotal: 28, implBytesAssembled: 8000, implBytesTotal: 20000, coverageRatio: 0.4, partitionsUsed: 2, partitionsCapped: 0, diffTotalPaths: 5, diffSelectedPaths: 5, diffOmittedPaths: 0 };

  it("skips zero/missing receipts and inherits the nearest effective one up the chain", async () => {
    // v44 合成零回执、v43 无回执行、v42 有效 → 继承 v42（生产 run 220 形态：上一版是回填快照）
    const execute = walkExecute([
      { id: 44, receipt: { ...realReceipt, implFilesTotal: 0, implFilesAssembled: 0, coverageRatio: 0 } },
      { id: 43, receipt: null },
      { id: 42, receipt: realReceipt },
    ]);
    const inherited = await loadInheritedCoverageReceipt(execute, 3, 45);
    expect(inherited?.fromSpecVersionId).toBe(42);
    expect(inherited?.versionsScanned).toBe(3);
    expect(inherited?.receipt.implFilesTotal).toBe(28);
    expect(inherited?.receipt.partitionsCapped).toBe(false);
    expect(inherited?.receipt.diffOmittedPaths).toBe(0);
  });

  it("returns null when the whole chain lacks an effective receipt (首次接入如实零回执)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const execute = walkExecute([{ id: 30, receipt: null }]);
      expect(await loadInheritedCoverageReceipt(execute, 3, 31)).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("caps the chain walk at maxVersions", async () => {
    const chain = Array.from({ length: 15 }, (_, index) => ({ id: 15 - index, receipt: null as Record<string, unknown> | null }));
    const execute = walkExecute(chain);
    const inherited = await loadInheritedCoverageReceipt(execute, 3, 20, 10);
    expect(inherited).toBeNull();
    expect(execute.mock.calls.filter(([sql]) => String(sql).includes("analysis_coverage_receipts")).length).toBe(10);
  });
});
