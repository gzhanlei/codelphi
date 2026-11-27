import { describe, expect, it } from "vitest";
import { VendoredDirectoryDetector, inspectDirectory, isLicenseName } from "../lib/slice-planner/vendored-directory";
import { createRemoteSourceIndex, gitBlobSha, type RemoteSourceBackend, type SourceRevisionRef } from "../lib/remote-source-index";
import type { OpenedRemoteSourceRevision, SourceTreeApiEntry, SourceTreeEntry } from "../lib/remote-source-index/types";

const blob = (path: string, sha = `sha-${path.split("/").pop()}`): SourceTreeEntry => ({ path, type: "blob", sha, parentPath: "", signals: [] });
const tree = (path: string): SourceTreeEntry => ({ path, type: "tree", sha: `tree-${path}`, parentPath: "", signals: [] });
const own = new Set(["sha-LICENSE"]);

describe("recognising a directory that holds a copy of someone else's project", () => {
  it("recognises an upstream project copied in whole, the way libopus sits inside an Android app", () => {
    // 真实形状（SalesBuddy 仓库，2026-11-27）：jni/libopus 里有 COPYING、AUTHORS、ChangeLog、NEWS、configure.ac、autogen.sh、opus.m4、Makefile.am。
    const verdict = inspectDirectory(
      [
        "jni/libopus/AUTHORS", "jni/libopus/COPYING", "jni/libopus/ChangeLog", "jni/libopus/NEWS", "jni/libopus/README", "jni/libopus/configure.ac",
        "jni/libopus/autogen.sh", "jni/libopus/opus.m4", "jni/libopus/Makefile.am", "jni/libopus/opus_sources.mk",
      ].map((path) => blob(path)).concat([tree("jni/libopus/src"), tree("jni/libopus/celt"), tree("jni/libopus/dnn")]),
      { ownLicenseShas: new Set(), rootHasLicense: false },
    );
    expect(verdict).toMatchObject({ vendored: true, reason: "upstream_project" });
    expect(verdict.markers).toEqual(["license", "authors", "news", "autotools"]);
  });

  it("goes by the licence when the repository has one to compare with", () => {
    // 根目录的许可证是 sha-LICENSE，这里是另一份。
    expect(inspectDirectory([blob("third_party/openssl/LICENSE", "sha-mit-openssl"), blob("third_party/openssl/ssl.c")], { ownLicenseShas: own, rootHasLicense: true })).toMatchObject({ vendored: true, reason: "foreign_license" });
    // 同一份许可证（monorepo 里每个包复制一份）：不是第三方，哪怕它还带着更新日志。
    const packageFiles = [blob("packages/api/LICENSE", "sha-LICENSE"), blob("packages/api/README.md"), blob("packages/api/CHANGELOG.md"), blob("packages/api/src/index.ts")];
    expect(inspectDirectory(packageFiles, { ownLicenseShas: own, rootHasLicense: true }).vendored).toBe(false);
  });

  it("does not go by the licence alone when the repository has none: then it takes three other markers", () => {
    // 根目录自己没有许可证文件：别人带来的许可证只算一个标记，单凭它不下结论。
    expect(inspectDirectory([blob("jni/libopus/COPYING"), blob("jni/libopus/src/opus.c")], { ownLicenseShas: new Set(), rootHasLicense: false }).vendored).toBe(false);
    // README + LICENSE + CHANGELOG 是很多第一方包的标准配置：两个标记，不够。
    expect(inspectDirectory([blob("lib/foo/LICENSE"), blob("lib/foo/CHANGELOG.md"), blob("lib/foo/index.js")], { ownLicenseShas: new Set(), rootHasLicense: false }).vendored).toBe(false);
    // 多了它自己的 CI 配置才像一个完整的上游项目。
    expect(inspectDirectory([blob("lib/foo/LICENSE"), blob("lib/foo/CHANGELOG.md"), tree("lib/foo/.github")], { ownLicenseShas: new Set(), rootHasLicense: false })).toMatchObject({ vendored: true, reason: "upstream_project" });
  });

  it("counts the repository's own licence as no marker: its copy plus three other markers still looks like an upstream project", () => {
    // 同一份许可证 + AUTHORS + NEWS + configure.ac、没有包描述文件：许可证不算，其余三个够了。
    const entries = [blob("lib/x/LICENSE", "sha-LICENSE"), blob("lib/x/AUTHORS"), blob("lib/x/NEWS"), blob("lib/x/configure.ac")];
    expect(inspectDirectory(entries, { ownLicenseShas: own, rootHasLicense: true })).toMatchObject({ vendored: true, reason: "upstream_project" });
    // 少一个标记就不下结论。
    expect(inspectDirectory(entries.slice(0, 3), { ownLicenseShas: own, rootHasLicense: true }).vendored).toBe(false);
  });

  it("leaves a first-party package alone: it carries its own package descriptor", () => {
    // 根目录没有许可证可比，但这个目录带着自己的包描述文件，是一个包，不是拷进来的上游项目。
    expect(inspectDirectory([blob("packages/api/LICENSE"), blob("packages/api/CHANGELOG.md"), tree("packages/api/.github"), blob("packages/api/package.json")], { ownLicenseShas: new Set(), rootHasLicense: false }).vendored).toBe(false);
    expect(inspectDirectory([blob("cmd/server/main.go"), blob("cmd/server/go.mod")], { ownLicenseShas: new Set(), rootHasLicense: false }).vendored).toBe(false);
    // 各生态的包定义都算：setup.py、Gemfile、mix.exs……
    for (const descriptor of ["setup.py", "setup.cfg", "Gemfile", "foo.gemspec", "build.sbt", "mix.exs", "Package.swift", "pubspec.yaml", "deno.json", "stack.yaml", "foo.cabal", "rebar.config", "shard.yml", "build.zig"]) {
      expect(inspectDirectory([blob(`lib/foo/${descriptor}`), blob("lib/foo/LICENSE"), blob("lib/foo/AUTHORS"), blob("lib/foo/NEWS")], { ownLicenseShas: new Set(), rootHasLicense: false }).vendored, descriptor).toBe(false);
    }
    // 构建脚本不算：拷进来的 C 项目也带着它们。
    for (const script of ["Makefile", "Makefile.in", "configure", "CMakeLists.txt", "autogen.sh"]) {
      expect(inspectDirectory([blob(`lib/foo/${script}`), blob("lib/foo/LICENSE"), blob("lib/foo/AUTHORS"), blob("lib/foo/NEWS")], { ownLicenseShas: new Set(), rootHasLicense: false }).vendored, script).toBe(true);
    }
    // 嵌在源码里的构建脚本目录（CMake 的模块）带好几个 autotools 标记，但没有许可证也没有更新日志。
    expect(inspectDirectory([blob("cmake/a.m4"), blob("cmake/b.m4"), blob("cmake/Makefile.am")], { ownLicenseShas: new Set(), rootHasLicense: false }).vendored).toBe(false);
  });

  it("says nothing about an ordinary source directory, and does not take code for a licence", () => {
    expect(inspectDirectory([blob("src/orders.ts"), blob("src/index.ts"), tree("src/lib")], { ownLicenseShas: own, rootHasLicense: true })).toEqual({ vendored: false, markers: [] });
    for (const name of ["LICENSE", "LICENSE.md", "COPYING", "COPYING.LESSER", "NOTICE.txt", "license-mit"]) expect(isLicenseName(name), name).toBe(true);
    for (const name of ["copyright.ts", "licenses.ts", "notice.py", "notices.md"]) expect(isLicenseName(name), name).toBe(false);
  });
});

function fakeIndex(trees: Record<string, SourceTreeApiEntry[]>, licences: Record<string, string> = {}) {
  const listed: string[] = [];
  const index = {
    scopeRoots: [],
    async listRoot() {
      return { path: "", entries: trees[""] ?? [], truncated: false, status: "indexed", metrics: { entryCount: 0, prunedCount: 0 } };
    },
    async listDir(path: string) {
      listed.push(path);
      return { path, entries: trees[path] ?? [], truncated: false, status: "indexed", metrics: { entryCount: 0, prunedCount: 0 } };
    },
    async readLines(request: { path: string }) {
      const lines = (licences[request.path] ?? "").split("\n");
      return { path: request.path, blobSha: "sha", treeEntrySha: "sha", startLine: 1, endLine: lines.length, lines, byteSize: 0, lineCount: lines.length, verified: true as const, cacheState: "fetched" as const, readReceipt: { requestedBy: "profile" as const, reason: "", fetchedAt: "" } };
    },
  } as unknown as OpenedRemoteSourceRevision;
  return { index, listed };
}

describe("the detector the planner and the coverage both ask", () => {
  it("reads the licences through the real index: a copy that differs only in whitespace is still the repository's own", async () => {
    const ref: SourceRevisionRef = { owner: "acme", repo: "shop", revision: "abc" };
    const files = new Map([
      ["LICENSE", "Copyright (c) 2024 Acme Inc.\nAll rights reserved.\n"],
      ["packages/api/LICENSE", "Copyright (c) 2026 Acme Inc.  All rights reserved."],
      ["packages/api/src/index.ts", "export const x = 1;\n"],
    ]);
    const blobEntry = (path: string): SourceTreeApiEntry => ({ path, type: "blob", sha: gitBlobSha(files.get(path)!), size: 50 });
    const treeEntry = (path: string): SourceTreeApiEntry => ({ path, type: "tree", sha: `tree-${path}` });
    const trees: Record<string, SourceTreeApiEntry[]> = {
      "": [blobEntry("LICENSE"), treeEntry("packages")],
      packages: [treeEntry("packages/api")],
      // 没有包描述文件，只有许可证和源码：全靠「这份许可证是不是自己的」来判断。
      "packages/api": [blobEntry("packages/api/LICENSE"), treeEntry("packages/api/src")],
      "packages/api/src": [blobEntry("packages/api/src/index.ts")],
    };
    const backend: RemoteSourceBackend = {
      kind: "github_api",
      resolveRevision: async () => ({ rootTreeSha: "tree-root" }),
      listTree: async (_source, _treeSha, path) => ({ entries: trees[path] ?? [], truncated: false }),
      fetchBlob: async (_source, path) => new TextEncoder().encode(files.get(path)!),
    };
    const index = await createRemoteSourceIndex(ref, { access: {}, scopeRoots: [{ path: "" }], backend });
    expect(await new VendoredDirectoryDetector(index, [{ path: "" }]).isVendored("packages/api")).toBe(false);
  });

  it("treats a licence as the repository's own when only the year differs", async () => {
    const { index } = fakeIndex(
      {
        "": [blob("LICENSE", "sha-root")],
        "packages/api": [blob("packages/api/LICENSE", "sha-copy"), blob("packages/api/CHANGELOG.md"), blob("packages/api/src/index.ts")],
        "vendor/x": [blob("vendor/x/LICENSE", "sha-mit"), blob("vendor/x/index.js")],
      },
      { "LICENSE": "Copyright (c) 2024 Acme Inc. All rights reserved.", "packages/api/LICENSE": "Copyright (c) 2026 Acme Inc.\nAll rights reserved.", "vendor/x/LICENSE": "MIT License Permission is hereby granted" },
    );
    const detector = new VendoredDirectoryDetector(index, [{ path: "" }]);
    expect(await detector.isVendored("packages/api")).toBe(false);
    expect(await detector.isVendored("vendor/x")).toBe(true);
  });

  it("never turns the repository root, a scope root or its ancestor into a third party", async () => {
    const { index } = fakeIndex({
      // 一个 C 项目的根目录：AUTHORS + NEWS + configure.ac，没有包描述文件——不保护的话它自己就被认成上游项目了。
      "": [blob("AUTHORS"), blob("NEWS"), blob("configure.ac"), tree("src")],
      "vendored-lib": [blob("vendored-lib/COPYING"), blob("vendored-lib/AUTHORS"), blob("vendored-lib/NEWS")],
      "other-copy": [blob("other-copy/COPYING"), blob("other-copy/AUTHORS"), blob("other-copy/NEWS")],
    });
    const detector = new VendoredDirectoryDetector(index, [{ path: "vendored-lib/src" }]);
    expect(await detector.isVendored("")).toBe(false);
    expect(await detector.isVendored("vendored-lib")).toBe(false);
    // 别的目录不受这份保护的影响。
    expect(await detector.isVendored("other-copy")).toBe(true);
  });

  it("takes a directory it cannot list as not vendored: reading its files fails later, loudly", async () => {
    const { index } = fakeIndex({ "": [blob("LICENSE")] });
    index.listDir = async () => {
      throw new Error("boom");
    };
    expect(await new VendoredDirectoryDetector(index, [{ path: "" }]).isVendored("anywhere")).toBe(false);
  });

  it("does not list a directory again when the caller hands over its listing", async () => {
    const { index, listed } = fakeIndex({ "": [blob("LICENSE")], lib: [blob("lib/index.ts")] });
    const detector = new VendoredDirectoryDetector(index, [{ path: "" }]);
    expect(await detector.inspect("lib", [blob("lib/index.ts")])).toEqual({ vendored: false, markers: [] });
    expect(listed).toEqual([]);
    // 判定有缓存：第二次问还是不列。
    expect(await detector.isVendored("lib")).toBe(false);
    expect(listed).toEqual([]);
  });

  it("finds the nearest third-party ancestor of a file and lists each directory once", async () => {
    const { index, listed } = fakeIndex({
      "": [blob("LICENSE")],
      "vendor/x": [blob("vendor/x/LICENSE", "sha-mit"), blob("vendor/x/index.js")],
      app: [],
      "app/jni": [],
      "app/jni/libopus": [blob("app/jni/libopus/COPYING"), blob("app/jni/libopus/AUTHORS"), blob("app/jni/libopus/NEWS"), blob("app/jni/libopus/configure.ac")],
    });
    const detector = new VendoredDirectoryDetector(index, [{ path: "" }]);
    expect(await detector.vendoredAncestorOf("app/jni/libopus/src/opus.c")).toBe("app/jni/libopus");
    expect(await detector.vendoredAncestorOf("app/main.c")).toBeNull();
    // 文件直接躺在那个目录里：它的父目录就是最近的第三方祖先。
    expect(await detector.vendoredAncestorOf("vendor/x/index.js")).toBe("vendor/x");
    // 根目录走 listRoot，不算在 listDir 里；每个目录只列一次，一层一层从上往下。
    expect(listed).toEqual(["app", "app/jni", "app/jni/libopus", "vendor", "vendor/x"]);
  });
});
