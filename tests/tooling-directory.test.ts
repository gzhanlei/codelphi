import { describe, expect, it } from "vitest";
import { ToolingDirectories, isToolingDirectory, referencedPaths, toolingDirectoriesApply } from "../lib/slice-planner/tooling-directory";
import type { OpenedRemoteSourceRevision, SourceTreeEntry } from "../lib/remote-source-index/types";

const blob = (path: string): SourceTreeEntry => ({ path, type: "blob", sha: `sha-${path}`, parentPath: "", signals: [] });
const tree = (path: string): SourceTreeEntry => ({ path, type: "tree", sha: `tree-${path}`, parentPath: "", signals: [] });

describe("recognising a tooling directory", () => {
  it("goes by the conventional names, and only directly under a scope root or a package", () => {
    for (const name of ["scripts", "Scripts", "script", "tooling", "devtools", "dev-tools", "hack", "hacks", "bin"]) {
      // 上一级带着包描述文件：monorepo 里每个包自己的脚本目录。
      expect(isToolingDirectory(`apps/web/${name}`, [blob("apps/web/package.json")], false), name).toBe(true);
      // 上一级就是产品的源码根目录。
      expect(isToolingDirectory(name, [], true), name).toBe(true);
    }
    // 同名的目录埋在源码更深处：可能是产品的一个模块。
    expect(isToolingDirectory("src/scripts", [blob("src/main.ts")], false)).toBe(false);
    // 上一级既不是源码根，也没有包描述文件。
    expect(isToolingDirectory("apps/web/scripts", [blob("apps/web/README.md")], false)).toBe(false);
    // tools 没有列入：Python 和 Django 项目里它常常是产品自己的工具模块。
    for (const name of ["tools", "utils", "cmd", "lib", "tasks", "jobs", "internal"]) expect(isToolingDirectory(name, [], true), name).toBe(false);
  });

  it("does not treat scripts as tooling when they are all the scope has", () => {
    // 整个仓库就是一堆脚本：它们是产品。
    expect(toolingDirectoriesApply([tree("scripts"), tree("tests"), blob("README.md")])).toBe(false);
    expect(toolingDirectoriesApply([tree("scripts"), tree("docs"), blob("package-lock.json"), tree("node_modules")])).toBe(false);
    // 有别的代码目录，或者有一份构建清单。
    expect(toolingDirectoriesApply([tree("scripts"), tree("src"), blob("README.md")])).toBe(true);
    expect(toolingDirectoriesApply([tree("bin"), blob("package.json")])).toBe(true);
    // 被剪掉的目录（构建产物、二进制）不算「别的东西」。
    expect(toolingDirectoriesApply([{ ...tree("dist"), pruned: { reason: "build_output" as const } }, tree("scripts")])).toBe(false);
  });
});

describe("which files of a tooling directory something starts in production", () => {
  it("finds the paths a deployment file runs", () => {
    const dockerfile = ["FROM node:20", "WORKDIR /app", "COPY . .", "RUN npm ci", "CMD [\"node\", \"scripts/server.js\"]", "ENTRYPOINT [\"./scripts/entry.sh\"]"];
    expect(referencedPaths("Dockerfile", dockerfile)).toEqual(["scripts/server.js", "scripts/entry.sh"]);
    expect(referencedPaths("Procfile", ["web: node scripts/server.js", "worker: python3 scripts/worker.py"])).toEqual(["scripts/server.js", "scripts/worker.py"]);
    // systemd 单元里是绝对路径：原样交回去，由调用方按目录名解析。
    expect(referencedPaths("app.service", ["[Service]", "ExecStart=/usr/bin/python3 /opt/app/scripts/serve.py", "Restart=always"])).toEqual(["/opt/app/scripts/serve.py"]);
    // 不是启动文件的东西不读。
    expect(referencedPaths("README.md", ["run scripts/server.js"])).toEqual([]);
  });

  it("reads a package manifest structurally: bin and the commands that run the product, not the development commands", () => {
    const manifest = JSON.stringify({
      name: "acme",
      main: "scripts/main.js",
      bin: { acme: "./scripts/cli.js", "acme-x": "scripts/x.js" },
      scripts: {
        build: "tsc -p scripts/build.ts",
        test: "vitest scripts/test-setup.ts",
        migrate: "ts-node scripts/migrate.ts",
        start: "node scripts/server.js",
        "start:worker": "node scripts/worker.js",
        dev: "tsx scripts/dev-server.ts",
      },
    });
    // 开头的 ./ 去掉。
    expect(referencedPaths("package.json", manifest.split("\n"))).toEqual(["scripts/cli.js", "scripts/x.js", "scripts/server.js", "scripts/worker.js", "scripts/dev-server.ts"]);
    // composer 的 bin 是数组。
    expect(referencedPaths("composer.json", ['{"bin": ["scripts/acme"]}'])).toEqual(["scripts/acme"]);
    // bin 是 null、scripts 不是对象：不报错，照常读其余的。
    expect(referencedPaths("package.json", ['{"bin": null, "scripts": {"start": "node scripts/server.js"}}'])).toEqual(["scripts/server.js"]);
    expect(referencedPaths("package.json", ['{"bin": {"a": 5, "b": "scripts/b.js"}, "scripts": "nope"}'])).toEqual(["scripts/b.js"]);
  });

  it("falls back to scanning the text when the manifest does not parse", () => {
    const json5 = ["{", "  // a comment", "  scripts: { start: 'node scripts/server.js' },", "}"];
    expect(referencedPaths("package.json", json5)).toEqual(["scripts/server.js"]);
  });
});

function fakeIndex(trees: Record<string, SourceTreeEntry[]>, texts: Record<string, string>) {
  const listed: string[] = [];
  const read: string[] = [];
  const listing = (path: string) => ({ path, entries: trees[path] ?? [], truncated: false, status: "indexed", metrics: { entryCount: 0, prunedCount: 0 } });
  const index = {
    scopeRoots: [],
    listRoot: async () => listing(""),
    async listDir(path: string) {
      listed.push(path);
      return listing(path);
    },
    async readLines(request: { path: string }) {
      read.push(request.path);
      const lines = (texts[request.path] ?? "").split("\n");
      return { path: request.path, blobSha: "sha", treeEntrySha: "sha", startLine: 1, endLine: lines.length, lines, byteSize: 0, lineCount: lines.length, verified: true as const, cacheState: "fetched" as const, readReceipt: { requestedBy: "profile" as const, reason: "", fetchedAt: "" } };
    },
  } as unknown as OpenedRemoteSourceRevision;
  return { index, listed, read };
}

describe("the tooling directories the planner and the coverage both ask", () => {
  it("names the entry points of a tooling directory and reads each invoker once", async () => {
    const { index, read } = fakeIndex(
      { "": [blob("package.json"), blob("Dockerfile"), blob("README.md"), tree("scripts"), tree("src")], scripts: [blob("scripts/server.js"), blob("scripts/build.ts")] },
      { "package.json": JSON.stringify({ scripts: { start: "node scripts/server.js", build: "tsc" } }), Dockerfile: "FROM node\nCMD [\"node\", \"scripts/worker.js\"]" },
    );
    const tooling = new ToolingDirectories(index, [{ path: "" }]);
    const parent = (await index.listRoot()).entries;
    expect([...(await tooling.entryPointsOf("scripts", parent))]).toEqual(["scripts/server.js", "scripts/worker.js"]);
    expect([...(await tooling.entryPointsOf("scripts", parent))]).toEqual(["scripts/server.js", "scripts/worker.js"]);
    expect(read).toEqual(["package.json", "Dockerfile"]);
  });

  it("resolves paths relative to the invoker's directory, to the repository root, and by directory name after an absolute prefix", async () => {
    const { index } = fakeIndex(
      { "": [blob("package.json"), blob("docker-compose.yml"), tree("scripts")], scripts: [blob("scripts/server.js"), blob("scripts/worker.js"), blob("scripts/entry.sh")] },
      {
        "package.json": JSON.stringify({ scripts: { start: "node ./scripts/server.js" } }),
        "docker-compose.yml": "services:\n  web:\n    command: python3 /opt/app/scripts/worker.js\n    entrypoint: scripts/entry.sh\n",
      },
    );
    const tooling = new ToolingDirectories(index, [{ path: "" }]);
    expect([...(await tooling.entryPointsOf("scripts", (await index.listRoot()).entries))]).toEqual(["scripts/server.js", "scripts/worker.js", "scripts/entry.sh"]);
  });

  it("resolves a path relative to the package that starts it, and ignores paths that lead out of the tooling directory", async () => {
    const { index } = fakeIndex(
      { "": [blob("package.json"), tree("apps")], apps: [tree("apps/web")], "apps/web": [blob("apps/web/package.json"), tree("apps/web/scripts"), tree("apps/web/lib")], "apps/web/scripts": [blob("apps/web/scripts/dev.ts"), blob("apps/web/scripts/server.js")] },
      {
        "package.json": JSON.stringify({ workspaces: ["apps/*"] }),
        "apps/web/package.json": JSON.stringify({ scripts: { start: "node scripts/dev.ts", migrate: "node scripts/../lib/migrate.ts", serve: "node lib/service.ts" } }),
      },
    );
    const tooling = new ToolingDirectories(index, [{ path: "" }]);
    expect([...(await tooling.entryPointsOf("apps/web/scripts", (await index.listDir("apps/web")).entries))]).toEqual(["apps/web/scripts/dev.ts"]);
  });

  it("resolves an absolute path for a package's own tooling directory", async () => {
    // monorepo 里包自己的 Dockerfile：容器里的绝对路径从工具目录的名字起截，接回这个包的位置。
    const { index } = fakeIndex(
      { "": [blob("package.json"), tree("apps")], apps: [tree("apps/web")], "apps/web": [blob("apps/web/Dockerfile"), tree("apps/web/scripts")], "apps/web/scripts": [blob("apps/web/scripts/server.js"), blob("apps/web/scripts/other.js")] },
      { "apps/web/Dockerfile": "FROM node\nCMD [\"node\", \"/app/apps/web/scripts/server.js\"]" },
    );
    const tooling = new ToolingDirectories(index, [{ path: "" }]);
    expect([...(await tooling.entryPointsOf("apps/web/scripts", (await index.listDir("apps/web")).entries))]).toEqual(["apps/web/scripts/server.js"]);
  });

  it("picks the innermost scope root of a path and keeps the whole-repository scope as the fallback", () => {
    const { index } = fakeIndex({}, {});
    const tooling = new ToolingDirectories(index, [{ path: "" }, { path: "apps/web" }]);
    expect(tooling.scopeRootOf("apps/web/scripts/dev.ts")).toBe("apps/web");
    expect(tooling.scopeRootOf("apps/web")).toBe("apps/web");
    expect(tooling.scopeRootOf("apps/api/main.go")).toBe("");
    expect(new ToolingDirectories(index, [{ path: "apps/web" }]).scopeRootOf("apps/api/main.go")).toBe("");
  });

  it("does not treat a scope as script-only when its listing cannot be read", async () => {
    const { index } = fakeIndex({}, {});
    index.listRoot = async () => {
      throw new Error("boom");
    };
    expect(await new ToolingDirectories(index, [{ path: "" }]).appliesWithin("")).toBe(false);
    // 已经传进清单的不再列。
    expect(await new ToolingDirectories(index, [{ path: "" }]).appliesWithin("", [tree("src"), tree("scripts")])).toBe(true);
  });

  it("keeps reading when an invoker cannot be read", async () => {
    const { index } = fakeIndex({ "": [blob("package.json"), blob("Procfile"), tree("scripts")] }, { "package.json": "not json at all", Procfile: "web: node scripts/server.js" });
    index.readLines = async (request: { path: string }) => {
      if (request.path === "package.json") throw new Error("boom");
      const lines = ["web: node scripts/server.js"];
      return { path: request.path, blobSha: "sha", treeEntrySha: "sha", startLine: 1, endLine: 1, lines, byteSize: 0, lineCount: 1, verified: true as const, cacheState: "fetched" as const, readReceipt: { requestedBy: "profile" as const, reason: "", fetchedAt: "" } };
    };
    expect([...(await new ToolingDirectories(index, [{ path: "" }]).entryPointsOf("scripts", (await index.listRoot()).entries))]).toEqual(["scripts/server.js"]);
  });

  it("finds the tooling directory a file sits in, and lists a directory only when a name says it might be one", async () => {
    const { index, listed } = fakeIndex(
      {
        "": [blob("package.json"), tree("scripts"), tree("apps"), tree("src")],
        scripts: [tree("scripts/lib"), blob("scripts/server.js")],
        "scripts/lib": [blob("scripts/lib/util.js")],
        apps: [tree("apps/web")],
        "apps/web": [blob("apps/web/package.json"), tree("apps/web/scripts")],
        "apps/web/scripts": [blob("apps/web/scripts/dev.ts")],
        src: [tree("src/scripts")],
        "src/scripts": [blob("src/scripts/x.ts")],
      },
      { "package.json": "{}" },
    );
    const tooling = new ToolingDirectories(index, [{ path: "" }]);
    // 工具目录的子目录里也一样；每个工具目录只列一次它的上一级。
    expect(await tooling.enclosing("scripts/lib/util.js")).toEqual({ directory: "scripts", entryPoints: new Set() });
    expect(await tooling.enclosing("apps/web/scripts/dev.ts")).toEqual({ directory: "apps/web/scripts", entryPoints: new Set() });
    expect(listed).toEqual(["apps/web"]);
    // 埋在 src 下面的同名目录：名字像，要列一下它的上一级才知道没有包描述文件——不是工具目录。
    expect(await tooling.enclosing("src/scripts/x.ts")).toBeNull();
    expect(listed).toEqual(["apps/web", "src"]);
    // 名字对不上的文件一个目录都不列。
    expect(await tooling.enclosing("src/a.ts")).toBeNull();
    expect(listed).toEqual(["apps/web", "src"]);
  });

  it("treats a directory directly under a scope root as tooling even without a package descriptor", async () => {
    // 仓库根没有包描述文件，产品是 apps/api（它的上一级就是源码根）；仓库根下的 hack 上一级既不是源码根也没有清单。
    const { index } = fakeIndex({ "": [tree("apps"), tree("hack")], "apps/api": [blob("apps/api/main.go"), tree("apps/api/bin")], "apps/api/bin": [blob("apps/api/bin/tool.sh")], hack: [blob("hack/up.sh")] }, {});
    const tooling = new ToolingDirectories(index, [{ path: "apps/api" }]);
    expect(await tooling.enclosing("apps/api/bin/tool.sh")).toEqual({ directory: "apps/api/bin", entryPoints: new Set() });
    expect(await tooling.enclosing("hack/up.sh")).toBeNull();
  });
});
