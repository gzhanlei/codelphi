import { describe, expect, it, vi } from "vitest";
import { computeCoverageReceipt, enumerateImplementationSurface, enumerateRequiredImplementationSurface, loadInheritedCoverageReceipt, saveCoverageReceipt } from "../lib/analysis-coverage";
import { computeScopeFingerprint } from "../lib/behavior-inventory";
import { createRemoteSourceIndex, type RemoteSourceBackend } from "../lib/remote-source-index";
import type { AnalysisPartition, } from "../lib/remote-analysis";
import type { OpenedRemoteSourceRevision, SourceTreeListing } from "../lib/remote-source-index";

const entry = (path: string, size: number, type: "blob" | "tree" = "blob") => ({ path, type, sha: path, size: type === "blob" ? size : undefined });

function fakeIndex(files: Array<{ path: string; size: number }>, trees?: Record<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>): OpenedRemoteSourceRevision {
  const dirs = new Set(files.map((file) => file.path.split("/").slice(0, -1).join("/")).filter(Boolean));
  const listing = (path: string): SourceTreeListing => ({
    path,
    truncated: false,
    status: "indexed" as const,
    metrics: { entryCount: 0, prunedCount: 0 },
    entries: trees ? trees[path] ?? [] : [
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

describe("third-party directories in the implementation surface", () => {
  // 真实形状（SalesBuddy 仓库，2026-11-27）：jni/libopus 是一个完整的 libopus 源码树，目录名看不出来。
  const blob = (path: string, size = 10) => ({ path, type: "blob" as const, sha: `sha-${path}`, size });
  const tree = (path: string) => ({ path, type: "tree" as const, sha: `tree-${path}` });
  const libopus = [blob("jni/libopus/COPYING", 30), blob("jni/libopus/AUTHORS"), blob("jni/libopus/NEWS"), blob("jni/libopus/configure.ac"), tree("jni/libopus/src")];
  const source = [blob("jni/libopus/src/opus.c", 900_000)];

  it("does not count a directory that carries a copy of someone else's project", async () => {
    const trees = { "": [blob("LICENSE"), blob("lib/service.ts", 100), tree("jni")], jni: [tree("jni/libopus")], "jni/libopus": libopus, "jni/libopus/src": source };
    expect((await enumerateImplementationSurface(fakeIndex([], trees))).map((file) => file.path)).toEqual(["lib/service.ts"]);
  });

  it("does not count a required path or a diff path the planner left inside a third-party copy", async () => {
    // 增量分析只 stat 必选路径、不列目录（tests/analysis-run.test.ts 钉着这条）：规划器排除的路径由调用方去掉。
    const index = {
      ...fakeIndex([]),
      listRoot: vi.fn(async () => { throw new Error("must not list the tree"); }),
      listDir: vi.fn(async () => { throw new Error("must not list the tree"); }),
      statPath: async (path: string) => ({ path, blobSha: `blob-${path}`, treeEntrySha: `tree-${path}`, byteSize: 10, cacheState: "cached" as const }),
    };
    const required = ["lib/service.ts", "jni/libopus/src/opus.c"];
    const excluded = [{ kind: "vendored" as const, path: "jni/libopus/src/opus.c", detail: "jni/libopus" }];
    expect((await enumerateRequiredImplementationSurface(index, required.filter((path) => path !== "jni/libopus/src/opus.c"))).map((file) => file.path)).toEqual(["lib/service.ts"]);
    // 规划器拦下了这个文件：它不会被装配，可它也不是遗漏。
    const assembled = [partition([{ path: "lib/service.ts", content: "x" }])];
    const receipt = computeCoverageReceipt({ index, partitions: assembled, implSurface: [{ path: "lib/service.ts", size: 10 }], diffPaths: required, excluded });
    expect(receipt).toMatchObject({ implFilesTotal: 1, implFilesAssembled: 1, diffTotalPaths: 1, diffSelectedPaths: 1, diffOmittedPaths: 0 });
  });

  it("keeps a scope root and everything under it, whatever the directory looks like", async () => {
    // 用户明确把产品指到了这个目录：它就是这个产品的代码。
    const trees = { "": [blob("LICENSE"), blob("lib/service.ts", 100), tree("jni")], jni: [tree("jni/libopus")], "jni/libopus": libopus, "jni/libopus/src": source };
    const index = { ...fakeIndex([], trees), scopeRoots: [{ path: "jni/libopus" }] };
    const surface = await enumerateImplementationSurface(index, Number.POSITIVE_INFINITY, index.scopeRoots);
    // 许可证、作者、更新日志本来就是文档，不在实现面里；源码留下了。scope 外的目录照旧不算。
    expect(surface.map((file) => file.path)).toEqual(["jni/libopus/src/opus.c"]);
  });

  it("needs three markers when the repository has no licence to compare with, and keeps a first-party package", async () => {
    // packages/api 带着 README + LICENSE + CHANGELOG + 自己的 CI，可它有构建清单：是一个包，不是拷进来的上游项目。
    const trees = {
      "": [blob("package.json"), blob("lib/service.ts", 100), tree("jni"), tree("packages")],
      jni: [tree("jni/libopus")],
      "jni/libopus": libopus,
      "jni/libopus/src": source,
      packages: [tree("packages/api")],
      "packages/api": [blob("packages/api/LICENSE"), blob("packages/api/CHANGELOG.md"), blob("packages/api/README.md"), blob("packages/api/package.json"), tree("packages/api/.github"), tree("packages/api/src")],
      "packages/api/src": [blob("packages/api/src/index.ts", 50)],
    };
    expect((await enumerateImplementationSurface(fakeIndex([], trees))).map((file) => file.path)).toEqual(["lib/service.ts", "packages/api/src/index.ts"]);
  });
});

describe("tooling directories in the implementation surface", () => {
  const blob = (path: string, size = 10) => ({ path, type: "blob" as const, sha: `sha-${path}`, size });
  const tree = (path: string) => ({ path, type: "tree" as const, sha: `tree-${path}` });
  const stat = (path: string) => ({ path, blobSha: `blob-${path}`, treeEntrySha: `tree-${path}`, byteSize: 10, cacheState: "cached" as const });

  it("does not count a tooling directory, except the entry points something starts in production", async () => {
    const trees = {
      "": [blob("package.json"), blob("Dockerfile"), blob("lib/service.ts", 100), tree("scripts")],
      scripts: [blob("scripts/server.js", 20), blob("scripts/worker.js", 20), blob("scripts/build.ts", 20), blob("scripts/migrate.ts", 20)],
    };
    const index = { ...fakeIndex([], trees), readLines: async (request: { path: string }) => ({ path: request.path, blobSha: "sha", treeEntrySha: "sha", startLine: 1, endLine: 2, lines: texts[request.path], byteSize: 0, lineCount: 2, verified: true as const, cacheState: "fetched" as const, readReceipt: { requestedBy: "profile" as const, reason: "", fetchedAt: "" } }) };
    const texts: Record<string, string[]> = { "package.json": [JSON.stringify({ scripts: { start: "node scripts/server.js" } })], Dockerfile: ["CMD [\"node\", \"scripts/worker.js\"]"] };
    expect((await enumerateImplementationSurface(index)).map((file) => file.path)).toEqual(["lib/service.ts", "scripts/server.js", "scripts/worker.js"]);
  });

  it("counts scripts as product code when they are all the scope has", async () => {
    const trees = { "": [blob("README.md"), tree("scripts")], scripts: [blob("scripts/a.sh", 20), blob("scripts/b.py", 20)] };
    expect((await enumerateImplementationSurface(fakeIndex([], trees))).map((file) => file.path)).toEqual(["scripts/a.sh", "scripts/b.py"]);
  });
});

describe("required implementation surface", () => {
  it("stats only required paths and excludes missing or non-implementation entries", async () => {
    const index = fakeIndex([]);
    const statPath = vi.fn(async (path: string) => {
      if (path === "lib/missing.ts") return null;
      return { path, blobSha: `blob-${path}`, treeEntrySha: `tree-${path}`, byteSize: path === "lib/a.ts" ? 100 : 50, cacheState: "cached" as const };
    });
    const surface = await enumerateRequiredImplementationSurface({ ...index, statPath }, ["README.md", "lib/missing.ts", "lib/a.ts"]);

    expect(surface).toEqual([{ path: "lib/a.ts", size: 100 }]);
    expect(statPath).toHaveBeenCalledTimes(2);
  });

  it("does not stat migration scripts", async () => {
    const statPath = vi.fn(async (path: string) => ({ path, blobSha: `blob-${path}`, treeEntrySha: `tree-${path}`, byteSize: 100, cacheState: "cached" as const }));
    const surface = await enumerateRequiredImplementationSurface({ ...fakeIndex([]), statPath }, ["migrations/084_spec_identity.sql", "db/schema.sql", "lib/a.ts"]);

    expect(surface).toEqual([{ path: "lib/a.ts", size: 100 }]);
    expect(statPath).toHaveBeenCalledTimes(1);
  });
});

describe("migration scripts are outside the implementation surface", () => {
  const tree = (extra: Array<{ path: string; size: number }>) => fakeIndex([{ path: "lib/a.ts", size: 4000 }, ...extra]);

  it("leaves them out of the full-tree denominator", async () => {
    const surface = await enumerateImplementationSurface(tree([{ path: "migrations/001_init.sql", size: 900_000 }, { path: "db/schema.sql", size: 5000 }, { path: "prisma/schema.prisma", size: 3000 }]));
    expect(surface).toEqual([
      { path: "lib/a.ts", size: 4000 },
      { path: "prisma/schema.prisma", size: 3000 },
    ]);
  });

  it("keeps the scope fingerprint unchanged when one is added, so a resumed run is not refused for it", async () => {
    const paths = async (files: Array<{ path: string; size: number }>) => (await enumerateImplementationSurface(tree(files))).map((file) => file.path);
    const without = await paths([]);
    const withMigration = await paths([{ path: "migrations/001_init.sql", size: 900_000 }]);
    expect(computeScopeFingerprint(withMigration, [])).toBe(computeScopeFingerprint(without, []));
  });

  it("does not count them as omitted diff paths", async () => {
    const index = tree([{ path: "migrations/001_init.sql", size: 900_000 }]);
    const assembled = [partition([{ path: "lib/a.ts", content: "x" }])];
    const mixed = computeCoverageReceipt({ index, partitions: assembled, implSurface: await enumerateImplementationSurface(index), diffPaths: ["lib/a.ts", "migrations/002_add_column.sql"] });
    expect(mixed).toMatchObject({ implFilesTotal: 1, implFilesAssembled: 1, diffTotalPaths: 1, diffSelectedPaths: 1, diffOmittedPaths: 0 });
    // 分析目标内的改动文件有一部分没被装配：总数是两者之和，遗漏如实可见。
    const partlyAssembled = computeCoverageReceipt({ index, partitions: assembled, implSurface: await enumerateImplementationSurface(index), diffPaths: ["lib/a.ts", "lib/missing.ts"] });
    expect(partlyAssembled).toMatchObject({ diffTotalPaths: 2, diffSelectedPaths: 1, diffOmittedPaths: 1 });
    // 窗口里只有迁移脚本：分析目标内没有任何改动，和没有窗口 diff 一样记 null。
    const onlyMigration = computeCoverageReceipt({ index, partitions: assembled, implSurface: await enumerateImplementationSurface(index), diffPaths: ["migrations/002_add_column.sql"] });
    expect(onlyMigration).toMatchObject({ diffTotalPaths: null, diffSelectedPaths: null, diffOmittedPaths: null });
  });

  it("applies the same predicate to the numerator if a partition was built elsewhere", async () => {
    const index = tree([]);
    const receipt = computeCoverageReceipt({ index, partitions: [partition([{ path: "lib/a.ts", content: "x" }, { path: "migrations/001_init.sql", content: "x".repeat(50) }])], implSurface: await enumerateImplementationSurface(index) });
    expect(receipt).toMatchObject({ implFilesAssembled: 1, implFilesTotal: 1 });
  });

  it("counts a file whose size is unknown as zero bytes, never as one", async () => {
    const listing = { path: "", truncated: false, status: "indexed" as const, metrics: { entryCount: 0, prunedCount: 0 }, entries: [{ path: "lib/a.ts", type: "blob", sha: "x" }] } as unknown as SourceTreeListing;
    const index = { ...fakeIndex([]), listRoot: async () => listing };
    expect(await enumerateImplementationSurface(index)).toEqual([{ path: "lib/a.ts", size: 0 }]);

    const withoutContent = { slice: { files: [{ path: "lib/b.ts" }] }, sources: [] } as unknown as AnalysisPartition;
    expect(computeCoverageReceipt({ index, partitions: [partition([{ path: "lib/a.ts", content: "1: a" }]), withoutContent], implSurface: [] })).toMatchObject({ implFilesTotal: 2, implBytesTotal: 1 });
  });
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
    const receipt = computeCoverageReceipt({ index, partitions: [shared, partition([{ path: "lib/b.ts", content: "y" }]), shared] });
    expect(receipt.implFilesAssembled).toBe(2);
  });

  it("does not cap new receipts at six partitions", async () => {
    const index = fakeIndex([{ path: "lib/a.ts", size: 1000 }]);
    const partitions = Array.from({ length: 7 }, () => partition([{ path: "lib/a.ts", content: "x" }]));
    const receipt = computeCoverageReceipt({
      index,
      partitions,
      implSurface: await enumerateImplementationSurface(index),
    });
    expect(receipt.partitionsUsed).toBe(7);
    expect(receipt.partitionsCapped).toBe(false);
  });

  it("reports zero coverage honestly when nothing was assembled", () => {
    const index = fakeIndex([{ path: "lib/a.ts", size: 4000 }]);
    const receipt = computeCoverageReceipt({ index, partitions: [] });
    expect(receipt.implFilesAssembled).toBe(0);
    expect(receipt.coverageRatio).toBe(0);
  });

  it("counts raw source bytes instead of line-number prefixes", () => {
    const index = fakeIndex([{ path: "lib/a.ts", size: 3 }]);
    const receipt = computeCoverageReceipt({
      index,
      partitions: [partition([{ path: "lib/a.ts", content: "1: a\n2: b" }])],
      implSurface: [{ path: "lib/a.ts", size: 3 }],
    });
    expect(receipt.implBytesAssembled).toBe(3);
    expect(receipt.coverageRatio).toBe(1);
  });

  it("keeps counting raw bytes when the numbered content ends with a newline and when a numbered line is empty", () => {
    // 源码索引给的内容以换行结尾，空的源码行渲染成“N: ”。两种情况下行号前缀都不该被算进字节数：
    // 还原出来是两行（“a”和一个空行），即 a、换行、换行，共 3 个字节。
    const index = fakeIndex([{ path: "lib/a.ts", size: 3 }]);
    const receipt = computeCoverageReceipt({ index, partitions: [partition([{ path: "lib/a.ts", content: "1: a\n2: \n" }])] });
    expect(receipt.implBytesAssembled).toBe(3);
    expect(receipt.implBytesTotal).toBe(3);
    expect(receipt.coverageRatio).toBe(1);
  });

  it("falls back to the assembled implementation surface instead of reporting zero totals", () => {
    const index = fakeIndex([]);
    const receipt = computeCoverageReceipt({
      index,
      partitions: [partition([{ path: "lib/a.ts", content: "1: a\n2: b" }])],
      implSurface: [],
    });
    expect(receipt.implFilesTotal).toBe(1);
    expect(receipt.implBytesTotal).toBe(3);
    expect(receipt.coverageRatio).toBe(1);
  });

  it("marks legacy receipts with null primaryRangesOmitted (inventory-only accounting, historical semantics preserved)", () => {
    // Task 14：主覆盖区间遗漏只由 inventory 编排路径填写；旧分区回执恒为 null，
    // sourceCoverage 完整性判定对旧回执保持历史语义（不新增 partial 条件）。
    const index = fakeIndex([{ path: "lib/a.ts", size: 1000 }]);
    const receipt = computeCoverageReceipt({ index, partitions: [partition([{ path: "lib/a.ts", content: "x" }])] });
    expect(receipt.primaryRangesOmitted).toBeNull();
  });

  it("skips pruned out-of-scope top-level directories instead of hitting the index scope guard (run 80)", async () => {
    // run 80（uxplay-android）：source_roots=["app/src/main","uxplay/lib"]，仓库根还有 deps/、gradle/
    // 等 scope 外目录。枚举 BFS 曾无条件 listDir 这些目录，索引 assertAllowed 抛
    // path_outside_product_scope 使整个 run 失败——分母本应只含 scope 内实现面。
    const trees = new Map<string, Array<{ path: string; type: "blob" | "tree"; sha: string; size?: number }>>([
      ["", [
        { path: "app", type: "tree", sha: "tree-app" },
        { path: "deps", type: "tree", sha: "tree-deps" },
        { path: "gradle", type: "tree", sha: "tree-gradle" },
        { path: "LICENSE", type: "blob", sha: "blob-license", size: 1000 },
      ]],
      ["app", [{ path: "app/src", type: "tree", sha: "tree-app-src" }]],
      ["app/src", [
        { path: "app/src/main", type: "tree", sha: "tree-app-main" },
        { path: "app/src/test", type: "tree", sha: "tree-app-test" },
      ]],
      ["app/src/main", [{ path: "app/src/main/MainActivity.kt", type: "blob", sha: "blob-main", size: 8000 }]],
      ["app/src/test", [{ path: "app/src/test/MainTest.kt", type: "blob", sha: "blob-test", size: 2000 }]],
    ]);
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      async resolveRevision() {
        return { rootTreeSha: "tree-root" };
      },
      async listTree(_source, _treeSha, path) {
        const entries = trees.get(path);
        if (!entries) throw new Error(`unexpected tree path ${path}`);
        return { entries, truncated: false };
      },
      async fetchBlob() {
        throw new Error("metadata-level enumeration must not fetch blobs");
      },
    };
    const index = await createRemoteSourceIndex(
      { owner: "gzhanlei", repo: "uxplay-android", revision: "abc" },
      { access: {}, scopeRoots: [{ path: "app/src/main" }], backend },
    );
    // 守卫确实会拒绝 scope 外目录（失败形态复现）
    await expect(index.listDir("deps")).rejects.toThrow("path is outside product scope");
    // 修复：枚举跳过 pruned 条目，只返回 scope 内实现面（测试文件不算实现面）
    const surface = await enumerateImplementationSurface(index);
    expect(surface).toEqual([{ path: "app/src/main/MainActivity.kt", size: 8000 }]);
  });
});

describe("saveCoverageReceipt", () => {
  it("persists the capped flag as 1 or 0 and leaves the diff columns null when there is no window diff", async () => {
    const execute = vi.fn(async (_sql: string, _params: unknown[]) => [{ affectedRows: 1 }]);
    const receipt = { implFilesAssembled: 1, implFilesTotal: 2, implBytesAssembled: 10, implBytesTotal: 20, coverageRatio: 0.5, partitionsUsed: 6, diffTotalPaths: null, diffSelectedPaths: null, diffOmittedPaths: null };
    await saveCoverageReceipt({ execute } as never, 7, { ...receipt, partitionsCapped: true });
    await saveCoverageReceipt({ execute } as never, 8, { ...receipt, partitionsCapped: false });
    expect(execute.mock.calls.map(([, params]) => params)).toEqual([
      [7, 1, 2, 10, 20, 0.5, 6, 1, null, null, null],
      [8, 1, 2, 10, 20, 0.5, 6, 0, null, null, null],
    ]);
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
    expect(inherited?.receipt.diffTotalPaths).toBe(5);
    expect(inherited?.receipt.diffSelectedPaths).toBe(5);
    expect(inherited?.receipt.diffOmittedPaths).toBe(0);
  });

  it("keeps the diff columns null for a legacy receipt that never had them, whether stored as null or missing", async () => {
    // 迁移 058 之前的回执没有 diff 三列。读取时它们必须保持 null，不能变成 0 或 NaN。
    for (const missing of [null, undefined]) {
      const legacy = { implFilesAssembled: 12, implFilesTotal: 28, implBytesAssembled: 8000, implBytesTotal: 20000, coverageRatio: 0.4, partitionsUsed: 2, partitionsCapped: 0, diffTotalPaths: missing, diffSelectedPaths: missing, diffOmittedPaths: missing };
      const inherited = await loadInheritedCoverageReceipt(walkExecute([{ id: 40, receipt: legacy }]), 3, 41);
      expect(inherited?.receipt).toMatchObject({ diffTotalPaths: null, diffSelectedPaths: null, diffOmittedPaths: null });
    }
  });

  it("treats a receipt of a one-file implementation surface as effective", async () => {
    // 有效回执的条件是“实现面非空”。只有一个实现文件的仓库，它的回执不能被当成合成零回执跳过。
    const inherited = await loadInheritedCoverageReceipt(walkExecute([{ id: 40, receipt: { ...realReceipt, implFilesTotal: 1, implFilesAssembled: 1 } }]), 3, 41);
    expect(inherited?.receipt.implFilesTotal).toBe(1);
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
