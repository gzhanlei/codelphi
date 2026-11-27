import { describe, expect, it } from "vitest";
import { createRemoteSourceIndex, gitBlobSha, type RemoteSourceBackend, type SourceRevisionRef, type SourceTreeApiEntry } from "../lib/remote-source-index";
import { sliceToSourceFiles } from "../lib/remote-analysis";
import { createSlicePlanner, type SliceBudgets } from "../lib/slice-planner";
import { isWalkNoiseDirectory, isSelectionManifest, selectionNoiseKind } from "../lib/slice-planner/selection-policy";

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

describe("selection policy classification", () => {
  it("classifies noise paths and keeps behavior-bearing source", () => {
    expect(selectionNoiseKind("test/app.route.js")).toBe("test");
    expect(selectionNoiseKind("packages/core/src/foo.test.ts")).toBe("test");
    expect(selectionNoiseKind("src/user.spec.ts")).toBe("test");
    expect(selectionNoiseKind("components/Button.stories.tsx")).toBe("test");
    expect(selectionNoiseKind("README.md")).toBe("doc");
    expect(selectionNoiseKind("AGENTS.md")).toBe("doc");
    expect(selectionNoiseKind("CHANGELOG.md")).toBe("doc");
    expect(selectionNoiseKind("docs/guide/intro.md")).toBe("doc");
    expect(selectionNoiseKind("examples/auth/index.js")).toBe("example");
    expect(selectionNoiseKind("bench/compile.ts")).toBe("bench");
    expect(selectionNoiseKind("vitest.config.ts")).toBe("config");
    expect(selectionNoiseKind("playwright.config.ts")).toBe("config");
    expect(selectionNoiseKind(".github/workflows/ci.yml")).toBe("ci");
    expect(selectionNoiseKind("src/flask/app.py")).toBeNull();
    expect(selectionNoiseKind("lib/router/index.js")).toBeNull();
    expect(selectionNoiseKind("apps/web/app/page.tsx")).toBeNull();
    // 迁移脚本不在分析目标里（2026-11-25 产品决定）：目录下的文件与 .sql 一律按 schema 噪声处理
    expect(selectionNoiseKind("migrations/001_init.sql")).toBe("schema");
    // Python 的 alembic、Rails 的 db/migrate 也是迁移脚本（2026-11-27 并入同一条规则）
    expect(selectionNoiseKind("alembic/versions/x.py")).toBe("schema");
    expect(selectionNoiseKind("db/migrate/20240101000000_create_users.rb")).toBe("schema");
    // 其它语言和框架的测试约定
    expect(selectionNoiseKind("src/commonTest/kotlin/FooTest.kt")).toBe("test");
    expect(selectionNoiseKind("internal/service/user_test.go")).toBe("test");
    expect(selectionNoiseKind("iosApp/AppTests/AppTests.swift")).toBe("test");
    expect(selectionNoiseKind("src/Acme.Tests/OrderServiceTests.cs")).toBe("test");
    expect(selectionNoiseKind("tests/test_login.py")).toBe("test");
    // 部署和构建文件、生成的代码
    expect(selectionNoiseKind("deploy/Dockerfile")).toBe("deployment");
    expect(selectionNoiseKind("docker-compose.prod.yml")).toBe("deployment");
    expect(selectionNoiseKind("app/build.gradle.kts")).toBeNull();
    expect(selectionNoiseKind("app/project.pbxproj")).toBe("build");
    expect(selectionNoiseKind("yarn.lock")).toBe("build");
    expect(selectionNoiseKind("api/user.pb.go")).toBe("generated");
    expect(selectionNoiseKind("db/schema.sql")).toBe("schema");
    expect(selectionNoiseKind("lib/migration-planner.ts")).toBeNull();
  });

  it("exempts build manifests, except inside a noise directory", () => {
    // 噪声目录里的清单是那个示例、基准或测试夹具自己的，不是这个产品的
    expect(selectionNoiseKind("packages/bench/package.json")).toBe("bench");
    expect(selectionNoiseKind("packages/api/package.json")).toBeNull();
    expect(isSelectionManifest("apps/api/go.mod")).toBe(true);
    expect(isSelectionManifest("README.md")).toBe(false);
  });

  it("skips noise and hidden directories at walk level", () => {
    expect(isWalkNoiseDirectory("test")).toBe(true);
    expect(isWalkNoiseDirectory("src/__tests__")).toBe(true);
    expect(isWalkNoiseDirectory("examples/auth")).toBe(true);
    expect(isWalkNoiseDirectory("packages/bench")).toBe(true);
    expect(isWalkNoiseDirectory(".github/workflows")).toBe(true);
    expect(isWalkNoiseDirectory("migrations")).toBe(true);
    expect(isWalkNoiseDirectory("superset/migrations/versions")).toBe(true);
    expect(isWalkNoiseDirectory("src")).toBe(false);
    expect(isWalkNoiseDirectory("lib/router")).toBe(false);
    expect(isWalkNoiseDirectory("")).toBe(false);
  });
});

function backendFrom(files: Map<string, string>, trees: Map<string, SourceTreeApiEntry[]>, onList?: (path: string) => void): RemoteSourceBackend {
  const sha = (path: string) => gitBlobSha(files.get(path)!);
  return {
    kind: "github_api",
    async resolveRevision() {
      return { rootTreeSha: "tree-root" };
    },
    async listTree(_source, _treeSha, path) {
      onList?.(path);
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

const tree = (path: string) => ({ path, type: "tree" as const, sha: `tree-${path}` });
const blob = (path: string) => ({ path, type: "blob" as const, sha: "filled-by-backend" });

async function planSelection(budgets: Partial<SliceBudgets>, files: Map<string, string>, trees: Map<string, SourceTreeApiEntry[]>, scopeRoots: Array<{ path: string }> = [{ path: "" }], onList?: (path: string) => void, diffPaths?: string[], excludePaths?: ReadonlySet<string>, discovery?: { mode?: "full" | "required_only"; requiredPaths?: string[] }) {
  const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots, backend: backendFrom(files, trees, onList) });
  return createSlicePlanner({ now: () => 20 }).plan({
    product: { id: 1, slug: "commerce", name: "Commerce" },
    repository: ref,
    scopeRoots,
    budgets: { ...baseBudgets, ...budgets },
    plannerVersion: "v1",
    profileVersion: "v1",
    diffPaths,
    excludePaths,
    discovery: discovery?.mode,
    requiredPaths: discovery?.requiredPaths,
  }, index);
}

describe("planner selection policy", () => {
  it("never descends into noise directories; their files stay unselected", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["lib/service.ts", "export const service = 1;\n"],
      ["test/router.spec.ts", "it('routes')\n"],
      ["examples/auth/index.js", "console.log('demo')\n"],
      ["bench/compile.ts", "export const bench = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), blob("lib/service.ts"), blob("test/router.spec.ts"), blob("examples/auth/index.js"), blob("bench/compile.ts"), tree("test"), tree("examples"), tree("bench"), tree("lib")]],
      ["test", [blob("test/router.spec.ts")]],
      ["examples", [blob("examples/auth/index.js")]],
      ["bench", [blob("bench/compile.ts")]],
      ["lib", [blob("lib/service.ts")]],
    ]);
    const listed: string[] = [];
    const result = await planSelection({}, files, trees, [{ path: "" }], (path) => listed.push(path));
    expect(result.status).toBe("completed");
    expect(result.slice?.files.map((file) => file.path)).toEqual(["package.json", "lib/service.ts"]);
    // 噪声目录不再被展开：tree 预算与选择预算都不为其花费
    expect(listed).not.toContain("test");
    expect(listed).not.toContain("examples");
    expect(listed).not.toContain("bench");
  });

  it("filters noise files sitting beside real source (filename-signal decoys)", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["lib/router.js", "module.exports = {};\n"],
      ["test/app.route.js", "it('routes');\n"],
      ["scripts/play.ts", "export const play = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), tree("lib"), tree("test"), tree("scripts")]],
      ["lib", [blob("lib/router.js")]],
      ["test", [blob("test/app.route.js")]],
      ["scripts", [blob("scripts/play.ts")]],
    ]);
    const result = await planSelection({}, files, trees, [{ path: "" }]);
    // 关键断言：test/app.route.js（route 信号 decoy）被排除；无类别的散文件（play.ts）允许保留
    expect(result.slice?.files.map((file) => file.path)).toEqual(["package.json", "lib/router.js", "scripts/play.ts"]);
  });

  it("selects the window's diff files first, but only those inside the analysis target (W0-7)", async () => {
    // W0-2 solo 重跑残余根因：窗口 diff 是行为证据的一手面，分析目标内的 diff 文件必须保证入选。
    // 2026-11-27 之前这个循环不看噪声分类，于是和代码一起改的测试、CI 文件每次都被塞进提示词，
    // 账本里引用测试的场景越积越多（codelphi 四天里从 19 条涨到 433 条）。现在噪声文件改了也不进。
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      [".github/labeler.yml", "python:\\n  - any: []\\n"],
      ["test/foo.spec.ts", "it('foo');\n"],
      ["src/main.ts", "export const main = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), tree(".github"), tree("test"), tree("src")]],
      [".github", [blob(".github/labeler.yml")]],
      ["test", [blob("test/foo.spec.ts")]],
      ["src", [blob("src/main.ts")]],
    ]);
    const result = await planSelection({ maxSelectedFiles: 5 }, files, trees, [{ path: "" }], undefined, [".github/labeler.yml", "test/foo.spec.ts", "src/main.ts"]);
    expect(result.status).toBe("completed");
    // 分析目标内的 diff 文件先于遍历入选；CI 文件和测试文件即使在窗口里改过也不选
    const paths = result.slice?.files.map((file) => file.path) ?? [];
    expect(paths).toEqual(["src/main.ts", "package.json"]);
  });

  it("spreads diff files across partitions before walking (W0-7)", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["src/a.ts", "export const a = 1;\n"],
      ["src/b.ts", "export const b = 2;\n"],
      ["src/c.ts", "export const c = 3;\n"],
      ["src/d.ts", "export const d = 4;\n"],
      ["lib/walk.ts", "export const walk = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), tree("src"), tree("lib")]],
      ["src", [blob("src/a.ts"), blob("src/b.ts"), blob("src/c.ts"), blob("src/d.ts")]],
      ["lib", [blob("lib/walk.ts")]],
    ]);
    const diffPaths = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
    // 分区 1：预算 2 全给 diff 文件
    const first = await planSelection({ maxSelectedFiles: 2 }, files, trees, [{ path: "" }], undefined, diffPaths);
    expect(first.slice?.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    // 分区 2：排除分区 1 后，剩余 diff 文件仍先于遍历
    const exclude = new Set(first.slice!.files.map((file) => file.path));
    const second = await planSelection({ maxSelectedFiles: 4 }, files, trees, [{ path: "" }], undefined, diffPaths, exclude);
    expect(second.slice?.files.map((file) => file.path)).toEqual(["src/c.ts", "src/d.ts", "package.json", "lib/walk.ts"]);
  });

  it("skips missing or unreadable diff paths without failing the plan (W0-7)", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["src/real.ts", "export const real = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), tree("src")]],
      ["src", [blob("src/real.ts")]],
    ]);
    const result = await planSelection({}, files, trees, [{ path: "" }], undefined, ["src/ghost.ts", "src/binary.bin", "src/real.ts"]);
    expect(result.status).toBe("completed");
    // 不可读 diff 路径静默跳过，剩余预算由遍历补位
    expect(result.slice?.files.map((file) => file.path)).toEqual(["src/real.ts", "package.json"]);
  });

  it("walks breadth-first so sibling subtrees both feed the window on tight budgets", async () => {
    const files = new Map([
      ["adapters/a/index.ts", "export const a = 1;\n"],
      ["adapters/b/index.ts", "export const b = 1;\n"],
      ["adapters/c/index.ts", "export const c = 1;\n"],
      ["src/core.ts", "export const core = 1;\n"],
      ["src/util.ts", "export const util = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [tree("adapters"), tree("src")]],
      ["adapters", [tree("adapters/a"), tree("adapters/b"), tree("adapters/c")]],
      ["adapters/a", [blob("adapters/a/index.ts")]],
      ["adapters/b", [blob("adapters/b/index.ts")]],
      ["adapters/c", [blob("adapters/c/index.ts")]],
      ["src", [blob("src/core.ts"), blob("src/util.ts")]],
    ]);
    const result = await planSelection({ maxSelectedFiles: 3 }, files, trees, [{ path: "" }]);
    const paths = result.slice?.files.map((file) => file.path) ?? [];
    expect(paths).toContain("src/core.ts");
  });

  it("binds the subtree share cap only when multiple subtrees compete", async () => {
    const files = new Map([
      ["adapters/a/index.ts", "export const a = 1;\n"],
      ["adapters/b/index.ts", "export const b = 1;\n"],
      ["adapters/c/index.ts", "export const c = 1;\n"],
      ["adapters/d/index.ts", "export const d = 1;\n"],
      ["src/core.ts", "export const core = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [tree("adapters"), tree("src")]],
      ["adapters", [tree("adapters/a"), tree("adapters/b"), tree("adapters/c"), tree("adapters/d")]],
      ["adapters/a", [blob("adapters/a/index.ts")]],
      ["adapters/b", [blob("adapters/b/index.ts")]],
      ["adapters/c", [blob("adapters/c/index.ts")]],
      ["adapters/d", [blob("adapters/d/index.ts")]],
      ["src", [blob("src/core.ts")]],
    ]);
    // maxSelectedFiles=4 → 份额 = ceil(4×0.5) = 2：adapters 最多 2 个，src 必须入选
    const result = await planSelection({ maxSelectedFiles: 4 }, files, trees, [{ path: "" }]);
    const adaptersCount = (result.slice?.files ?? []).filter((file) => file.path.startsWith("adapters/")).length;
    expect(adaptersCount).toBeLessThanOrEqual(2);
    expect((result.slice?.files ?? []).some((file) => file.path === "src/core.ts")).toBe(true);
  });

  it("does not bind the share cap when only one subtree exists", async () => {
    const files = new Map([
      ["go.mod", "module commerce\n"],
      ["internal/server.go", "package internal\n"],
      ["internal/routes.go", "package internal\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("go.mod"), tree("internal")]],
      ["internal", [blob("internal/server.go"), blob("internal/routes.go")]],
    ]);
    const result = await planSelection({ maxSelectedFiles: 2 }, files, trees, [{ path: "" }]);
    // 两个普通源文件无优先级差，按 basename 字母序（routes < server）
    expect(result.slice?.files.map((file) => file.path)).toEqual(["go.mod", "internal/routes.go"]);
  });

  it("never selects migration files, not even as window diff or required paths", async () => {
    // 迁移脚本移出了分析目标：强制装入的循环本来不看噪声分类，所以这里单独拦住它。
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["migrations/001_init.sql", "CREATE TABLE a (id INT PRIMARY KEY);\n"],
      ["db/report.sql", "SELECT 1;\n"],
      ["src/main.ts", "export const main = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), tree("migrations"), tree("db"), tree("src")]],
      ["migrations", [blob("migrations/001_init.sql")]],
      ["db", [blob("db/report.sql")]],
      ["src", [blob("src/main.ts")]],
    ]);
    const listed: string[] = [];
    const forced = await planSelection({}, files, trees, [{ path: "" }], (path) => listed.push(path), ["migrations/001_init.sql", "db/report.sql", "src/main.ts"]);
    expect(forced.slice?.files.map((file) => file.path)).toEqual(["src/main.ts", "package.json"]);
    expect(listed).not.toContain("migrations");

    const required = await planSelection({}, files, trees, [{ path: "" }], undefined, ["migrations/001_init.sql"], undefined, {
      mode: "required_only",
      requiredPaths: ["migrations/001_init.sql", "db/report.sql", "src/main.ts"],
    });
    expect(required.slice?.files.map((file) => file.path)).toEqual(["src/main.ts"]);
  });

  it("selects only unique required paths without full-tree discovery", async () => {
    const files = new Map([
      ["lib/change.ts", "export const change = 1;\n"],
      ["lib/context.ts", "export const context = 1;\n"],
      ["lib/unrelated.ts", "export const unrelated = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("lib/change.ts"), blob("lib/context.ts"), blob("lib/unrelated.ts"), tree("lib")]],
      ["lib", [blob("lib/change.ts"), blob("lib/context.ts"), blob("lib/unrelated.ts")]],
    ]);
    const listed: string[] = [];
    const result = await planSelection({}, files, trees, [{ path: "" }], (path) => listed.push(path), ["lib/change.ts"], undefined, {
      mode: "required_only",
      requiredPaths: ["lib/context.ts", "lib/change.ts", "lib/context.ts"],
    });

    expect(result.slice?.files.map((file) => file.path)).toEqual(["lib/change.ts", "lib/context.ts"]);
    expect(listed).not.toContain("lib");
  });

  it("falls back to diff paths in required-only mode and walks scope by default", async () => {
    const files = new Map([
      ["lib/change.ts", "export const change = 1;\n"],
      ["lib/unrelated.ts", "export const unrelated = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("lib/change.ts"), blob("lib/unrelated.ts"), tree("lib")]],
      ["lib", [blob("lib/change.ts"), blob("lib/unrelated.ts")]],
    ]);
    const scoped = await planSelection({}, files, trees, [{ path: "" }], undefined, ["lib/change.ts"], undefined, { mode: "required_only" });
    expect(scoped.slice?.files.map((file) => file.path)).toEqual(["lib/change.ts"]);

    const listed: string[] = [];
    const full = await planSelection({}, files, trees, [{ path: "" }], (path) => listed.push(path), ["lib/change.ts"], undefined, { requiredPaths: ["lib/change.ts"] });
    expect(full.slice?.files.map((file) => file.path)).toContain("lib/unrelated.ts");
    expect(listed).toContain("lib");
  });
});

describe("sliceToSourceFiles hard cap", () => {
  it("stops including whole files once the byte budget is exhausted", async () => {
    const readLines = async (request: { path: string; startLine: number; endLine: number }) => {
      const content = `export const x = '${request.path}';\n`;
      return {
        startLine: request.startLine,
        endLine: request.endLine,
        lineCount: 1,
        byteSize: Buffer.byteLength(content),
        lines: [content.replace(/\n$/, "")],
      };
    };
    const index = { readLines } as never;
    const slice = {
      files: [
        { path: "a.ts", blobSha: "s", treeEntrySha: "s", byteSize: 100, lineRanges: [{ startLine: 1, endLine: 1, purpose: "service" }], signals: ["service" as const] },
        { path: "b.ts", blobSha: "s", treeEntrySha: "s", byteSize: 100, lineRanges: [{ startLine: 1, endLine: 1, purpose: "service" }], signals: ["service" as const] },
        { path: "c.ts", blobSha: "s", treeEntrySha: "s", byteSize: 100, lineRanges: [{ startLine: 1, endLine: 1, purpose: "service" }], signals: ["service" as const] },
      ],
    } as never;
    // 每文件约 30 字节：预算 50 → a 进入（~30），b 会到 ~60 超预算被排除
    const files = await sliceToSourceFiles(slice, index, 50);
    expect(files.map((file) => file.path)).toEqual(["a.ts"]);
  });
});
