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

async function planSelection(budgets: Partial<SliceBudgets>, files: Map<string, string>, trees: Map<string, SourceTreeApiEntry[]>, scopeRoots: Array<{ path: string }> = [{ path: "" }], onList?: (path: string) => void, diffPaths?: string[], excludePaths?: ReadonlySet<string>, discovery?: { mode?: "full" | "required_only"; requiredPaths?: string[] }, extra?: { excludeBlobs?: ReadonlyMap<string, string> }) {
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
    excludeBlobs: extra?.excludeBlobs,
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

  it("never walks into a directory that carries a copy of someone else's project; its files stay unselected and the exclusion is reported", async () => {
    // 真实形状（SalesBuddy 仓库，2026-11-27）：jni/libopus 是一个完整的 libopus 源码树，目录名看不出来。
    const files = new Map([
      ["LICENSE", "MIT\n"],
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["lib/service.ts", "export const service = 1;\n"],
      ["jni/libopus/COPYING", "BSD 3-Clause\n"],
      ["jni/libopus/AUTHORS", "Jean-Marc Valin\n"],
      ["jni/libopus/NEWS", "1.5\n"],
      ["jni/libopus/configure.ac", "AC_INIT\n"],
      ["jni/libopus/src/opus.c", "int opus_encode(void) { return 0; }\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("LICENSE"), blob("package.json"), tree("lib"), tree("jni")]],
      ["lib", [blob("lib/service.ts")]],
      ["jni", [tree("jni/libopus")]],
      ["jni/libopus", [blob("jni/libopus/COPYING"), blob("jni/libopus/AUTHORS"), blob("jni/libopus/NEWS"), blob("jni/libopus/configure.ac"), tree("jni/libopus/src")]],
      ["jni/libopus/src", [blob("jni/libopus/src/opus.c")]],
    ]);
    const listed: string[] = [];
    const result = await planSelection({}, files, trees, [{ path: "" }], (path) => listed.push(path));
    expect(result.status).toBe("completed");
    expect(result.slice?.files.map((file) => file.path)).toEqual(["package.json", "lib/service.ts"]);
    expect(listed).not.toContain("jni/libopus/src");
    // 根目录的许可证是 MIT，这里是 BSD：判据是「带着一份别人家的许可证」。
    expect(result.excluded).toEqual([{ kind: "vendored", path: "jni/libopus", detail: "foreign_license" }]);
  });

  it("does not force a changed file into the window when it sits inside a copy of someone else's project", async () => {
    const files = new Map([
      ["LICENSE", "MIT\n"],
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["src/main.ts", "export const main = 1;\n"],
      ["jni/libopus/COPYING", "BSD 3-Clause\n"],
      ["jni/libopus/AUTHORS", "x\n"],
      ["jni/libopus/NEWS", "x\n"],
      ["jni/libopus/src/opus.c", "int opus_encode(void) { return 0; }\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("LICENSE"), blob("package.json"), tree("src"), tree("jni")]],
      ["src", [blob("src/main.ts")]],
      ["jni", [tree("jni/libopus")]],
      ["jni/libopus", [blob("jni/libopus/COPYING"), blob("jni/libopus/AUTHORS"), blob("jni/libopus/NEWS"), tree("jni/libopus/src")]],
      ["jni/libopus/src", [blob("jni/libopus/src/opus.c")]],
    ]);
    const result = await planSelection({}, files, trees, [{ path: "" }], undefined, ["jni/libopus/src/opus.c", "src/main.ts"]);
    expect(result.slice?.files.map((file) => file.path)).toEqual(["src/main.ts", "package.json"]);
    // 两条记录：必选循环里被拦下的那个文件（原因是它所在的目录），和遍历遇到的那个目录本身。
    expect(result.excluded).toEqual([
      { kind: "vendored", path: "jni/libopus/src/opus.c", detail: "jni/libopus" },
      { kind: "vendored", path: "jni/libopus", detail: "foreign_license" },
    ]);
  });

  it("leaves a tooling directory out of the window but keeps the entry points something starts in production", async () => {
    const files = new Map([
      ["package.json", JSON.stringify({ dependencies: { express: "4.0.0" }, scripts: { start: "node scripts/server.js", build: "tsc scripts/build.ts", migrate: "node scripts/migrate.ts" } }) + "\n"],
      ["Dockerfile", "FROM node:20\nCMD [\"node\", \"scripts/worker.js\"]\n"],
      ["lib/service.ts", "export const service = 1;\n"],
      ["scripts/server.js", "module.exports = require('../lib/service');\n"],
      ["scripts/worker.js", "require('../lib/service');\n"],
      ["scripts/build.ts", "export const build = 1;\n"],
      ["scripts/migrate.ts", "export const migrate = 1;\n"],
      ["scripts/lib/util.js", "module.exports = {};\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), blob("Dockerfile"), tree("lib"), tree("scripts")]],
      ["lib", [blob("lib/service.ts")]],
      ["scripts", [blob("scripts/server.js"), blob("scripts/worker.js"), blob("scripts/build.ts"), blob("scripts/migrate.ts"), tree("scripts/lib")]],
      ["scripts/lib", [blob("scripts/lib/util.js")]],
    ]);
    const result = await planSelection({}, files, trees);
    // package.json 的 start 和 Dockerfile 的 CMD 点到的文件留下；build、migrate 命令点到的和没被点到的都不留。
    expect(result.slice?.files.map((file) => file.path).sort()).toEqual(["lib/service.ts", "package.json", "scripts/server.js", "scripts/worker.js"]);
    expect(result.excluded).toEqual([
      { kind: "tooling", path: "scripts/build.ts", detail: "scripts" },
      { kind: "tooling", path: "scripts/migrate.ts", detail: "scripts" },
      { kind: "tooling", path: "scripts/lib/util.js", detail: "scripts" },
    ]);
    // 下一趟：此前的分区已经拿走这些文件，工具目录的入口也不再重选，也不被记成排除。
    const nextPass = await planSelection({}, files, trees, [{ path: "" }], undefined, undefined, new Set(["lib/service.ts", "package.json", "scripts/server.js", "scripts/worker.js"]));
    expect(nextPass.slice?.files ?? []).toEqual([]);
    expect(nextPass.excluded).toEqual([
      { kind: "tooling", path: "scripts/build.ts", detail: "scripts" },
      { kind: "tooling", path: "scripts/migrate.ts", detail: "scripts" },
      { kind: "tooling", path: "scripts/lib/util.js", detail: "scripts" },
    ]);
  });

  it("forces a changed file in a tooling directory into the window only when it is a registered entry point", async () => {
    const files = new Map([
      ["package.json", JSON.stringify({ scripts: { start: "node scripts/server.js", build: "tsc scripts/build.ts" } }) + "\n"],
      ["lib/service.ts", "export const service = 1;\n"],
      ["scripts/server.js", "require('../lib/service');\n"],
      ["scripts/build.ts", "export const build = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), tree("lib"), tree("scripts")]],
      ["lib", [blob("lib/service.ts")]],
      ["scripts", [blob("scripts/server.js"), blob("scripts/build.ts")]],
    ]);
    const required = ["scripts/build.ts", "scripts/server.js", "lib/service.ts"];
    const result = await planSelection({}, files, trees, [{ path: "" }], undefined, required, undefined, { mode: "required_only", requiredPaths: required });
    expect(result.slice?.files.map((file) => file.path).sort()).toEqual(["lib/service.ts", "scripts/server.js"]);
    expect(result.excluded).toEqual([{ kind: "tooling", path: "scripts/build.ts", detail: "scripts" }]);
  });

  it("treats scripts as the product when they are all the scope has", async () => {
    const files = new Map([["README.md", "# tools\n"], ["scripts/a.sh", "echo hi\n"], ["scripts/b.py", "print('hi')\n"]]);
    const trees = new Map<string, SourceTreeApiEntry[]>([["", [blob("README.md"), tree("scripts")]], ["scripts", [blob("scripts/a.sh"), blob("scripts/b.py")]]]);
    const result = await planSelection({}, files, trees);
    expect(result.slice?.files.map((file) => file.path).sort()).toEqual(["scripts/a.sh", "scripts/b.py"]);
    expect(result.excluded).toEqual([]);
    // 必选循环里也一样：改了的脚本照常强制进窗口。
    const changed = ["scripts/a.sh"];
    const incremental = await planSelection({}, files, trees, [{ path: "" }], undefined, changed, undefined, { mode: "required_only", requiredPaths: changed });
    expect(incremental.slice?.files.map((file) => file.path)).toEqual(["scripts/a.sh"]);
    expect(incremental.excluded).toEqual([]);
  });

  it("treats a directory with a tooling name as tooling under a package that has a descriptor, not deeper in the source", async () => {
    const files = new Map([
      ["package.json", "{}\n"],
      ["apps/web/package.json", "{}\n"],
      ["apps/web/scripts/dev.ts", "export const dev = 1;\n"],
      ["apps/web/src/page.tsx", "export default function Page() {}\n"],
      ["src/tools/format.ts", "export const format = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), tree("apps"), tree("src")]],
      ["apps", [tree("apps/web")]],
      ["apps/web", [blob("apps/web/package.json"), tree("apps/web/scripts"), tree("apps/web/src")]],
      ["apps/web/scripts", [blob("apps/web/scripts/dev.ts")]],
      ["apps/web/src", [blob("apps/web/src/page.tsx")]],
      ["src", [tree("src/tools")]],
      ["src/tools", [blob("src/tools/format.ts")]],
    ]);
    const result = await planSelection({}, files, trees);
    expect(result.slice?.files.map((file) => file.path)).toContain("src/tools/format.ts");
    expect(result.excluded).toEqual([{ kind: "tooling", path: "apps/web/scripts/dev.ts", detail: "apps/web/scripts" }]);
  });

  it("analyses identical content once and reports the other copy", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["lib/a.ts", "export const same = 1;\n"],
      ["lib/b.ts", "export const other = 2;\n"],
      ["lib/copy.ts", "export const same = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([["", [blob("package.json"), tree("lib")]], ["lib", [blob("lib/a.ts"), blob("lib/b.ts"), blob("lib/copy.ts")]]]);
    const result = await planSelection({}, files, trees);
    expect(result.slice?.files.map((file) => file.path)).toEqual(["package.json", "lib/a.ts", "lib/b.ts"]);
    expect(result.excluded).toEqual([{ kind: "duplicate", path: "lib/copy.ts", detail: "lib/a.ts" }]);
    // 下一趟：此前分区拿走的那份内容（按 git blob 认）也算分析过。
    const next = await planSelection({}, files, trees, [{ path: "" }], undefined, undefined, new Set(["package.json", "lib/a.ts", "lib/b.ts"]), undefined, { excludeBlobs: new Map([[gitBlobSha(files.get("lib/a.ts")!), "lib/a.ts"]]) });
    expect(next.slice?.files ?? []).toEqual([]);
    expect(next.excluded).toEqual([{ kind: "duplicate", path: "lib/copy.ts", detail: "lib/a.ts" }]);
  });

  it("does not dedupe manifests: they are there to recognise the stack, not to be sent to the model", async () => {
    const files = new Map([["package.json", "{}\n"], ["apps/web/package.json", "{}\n"], ["apps/web/src/page.tsx", "export default function Page() {}\n"]]);
    const trees = new Map<string, SourceTreeApiEntry[]>([["", [blob("package.json"), tree("apps")]], ["apps", [tree("apps/web")]], ["apps/web", [blob("apps/web/package.json"), tree("apps/web/src")]], ["apps/web/src", [blob("apps/web/src/page.tsx")]]]);
    const result = await planSelection({}, files, trees);
    expect(result.slice?.files.map((file) => file.path)).toEqual(["package.json", "apps/web/package.json", "apps/web/src/page.tsx"]);
    expect(result.excluded).toEqual([]);
  });

  it("leaves out a file whose header says it was generated, and keeps product code that merely mentions generating", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      // 真实的生成标记：sqlc、openapi-generator、Flutter。
      ["lib/db/orders.sql.go", "// Code generated by sqlc. DO NOT EDIT.\n\npackage db\n"],
      ["lib/sdk/client.ts", "// @generated by openapi-generator\nexport const client = 1;\n"],
      ["lib/registrant.swift", "//  Generated file. Do not edit.\nimport Flutter\n"],
      // 真实的误伤（审计 2026-11-27）：产品代码只是在说「验证码是生成的」「JWT 是生成的」「别的文件由这个文件生成」。
      ["lib/otp/service.go", "// Codes are generated with a cryptographically secure RNG and stored in Redis.\npackage otp\n"],
      ["lib/adapters/kling.ts", "/**\n * Authentication: JWT Bearer token generated from Access Key + Secret Key.\n */\nexport const kling = 1;\n"],
      ["lib/fonts.config.mjs", "/**\n * Font families. fonts.css is GENERATED from this file by the build.\n */\nexport const fonts = {};\n"],
    ]);
    const lib = [blob("lib/db/orders.sql.go"), blob("lib/sdk/client.ts"), blob("lib/registrant.swift"), blob("lib/otp/service.go"), blob("lib/adapters/kling.ts"), blob("lib/fonts.config.mjs")];
    const trees = new Map<string, SourceTreeApiEntry[]>([["", [blob("package.json"), tree("lib")]], ["lib", lib]]);
    const result = await planSelection({}, files, trees);
    expect(result.slice?.files.map((file) => file.path)).toEqual(["package.json", "lib/fonts.config.mjs", "lib/adapters/kling.ts", "lib/otp/service.go"]);
    expect(result.excluded).toEqual([
      { kind: "generated", path: "lib/sdk/client.ts", detail: "@generated" },
      { kind: "generated", path: "lib/db/orders.sql.go", detail: "sqlc" },
      { kind: "generated", path: "lib/registrant.swift", detail: "generated file" },
    ]);
  });

  it("does not force a generated file or a second copy into the window", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["lib/a.ts", "export const same = 1;\n"],
      ["lib/copy.ts", "export const same = 1;\n"],
      ["lib/db/orders.sql.go", "// Code generated by sqlc. DO NOT EDIT.\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([["", [blob("package.json"), tree("lib")]], ["lib", [blob("lib/a.ts"), blob("lib/copy.ts"), blob("lib/db/orders.sql.go")]]]);
    const required = ["lib/db/orders.sql.go", "lib/copy.ts", "lib/a.ts"];
    const result = await planSelection({}, files, trees, [{ path: "" }], undefined, required, undefined, { mode: "required_only", requiredPaths: required });
    // 必选路径按路径排序：先到的那份（a.ts）留下，后到的（copy.ts）算重复。
    expect(result.slice?.files.map((file) => file.path)).toEqual(["lib/a.ts"]);
    expect(result.excluded).toEqual([
      { kind: "duplicate", path: "lib/copy.ts", detail: "lib/a.ts" },
      { kind: "generated", path: "lib/db/orders.sql.go", detail: "sqlc" },
    ]);
  });

  it("filters noise files sitting beside real source (filename-signal decoys)", async () => {
    const files = new Map([
      ["package.json", "{\"dependencies\":{\"express\":\"4.0.0\"}}\n"],
      ["lib/router.js", "module.exports = {};\n"],
      ["test/app.route.js", "it('routes');\n"],
      ["play.ts", "export const play = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("package.json"), blob("play.ts"), tree("lib"), tree("test")]],
      ["lib", [blob("lib/router.js")]],
      ["test", [blob("test/app.route.js")]],
    ]);
    const result = await planSelection({}, files, trees, [{ path: "" }]);
    // 关键断言：test/app.route.js（route 信号 decoy）被排除；无类别的散文件（play.ts）允许保留。
    // 2026-11-27 之前这个散文件放在 scripts/ 下；scripts 成了开发工具目录，换到仓库根。
    expect(result.slice?.files.map((file) => file.path)).toEqual(["package.json", "play.ts", "lib/router.js"]);
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
      ["other/thing.ts", "export const thing = 1;\n"],
    ]);
    const trees = new Map<string, SourceTreeApiEntry[]>([
      ["", [blob("lib/change.ts"), blob("lib/context.ts"), blob("lib/unrelated.ts"), tree("lib"), tree("other")]],
      ["lib", [blob("lib/change.ts"), blob("lib/context.ts"), blob("lib/unrelated.ts")]],
      ["other", [blob("other/thing.ts")]],
    ]);
    const listed: string[] = [];
    const result = await planSelection({}, files, trees, [{ path: "" }], (path) => listed.push(path), ["lib/change.ts"], undefined, {
      mode: "required_only",
      requiredPaths: ["lib/context.ts", "lib/change.ts", "lib/context.ts"],
    });

    expect(result.slice?.files.map((file) => file.path)).toEqual(["lib/change.ts", "lib/context.ts"]);
    // 不做全树发现：和必选路径无关的目录一个都不列。必选路径的祖先目录会看一眼是不是拷进来的上游项目
    // （逐目录展开时读文件本来就要逐层列出这些祖先，这里不多花一次）。
    expect(listed).not.toContain("other");
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
