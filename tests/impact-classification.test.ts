import { describe, expect, it } from "vitest";
import { IMPACT_RULES_VERSION, classifyFile, classifyWindow, type ChangedFile } from "../lib/impact-classification";

const BEHAVIORAL_PATCH = "@@ -10,2 +10,2 @@\n-  return computeOld(input);\n+  return computeNew(input);\n";
const COMMENT_ONLY_PATCH = "@@ -10,0 +11,2 @@\n+// 旧的实现已经换掉，下面走新的入口。\n+// 入参保持不变。\n";

type FileOverride = Partial<Omit<ChangedFile, "status" | "oldPath">> & Pick<ChangedFile, "path"> & Partial<Pick<ChangedFile, "status" | "oldPath">>;

function file(partial: FileOverride): ChangedFile {
  return {
    oldPath: null,
    status: "modified",
    oldMode: "100644",
    newMode: "100644",
    oldBlobSha: "a".repeat(40),
    newBlobSha: "b".repeat(40),
    binary: false,
    patch: BEHAVIORAL_PATCH,
    ...partial,
  } as ChangedFile;
}

const index = new Map<string, readonly string[]>([
  ["lib/analysis.ts", ["analysis:run", "analysis:save"]],
  ["lib/spec-versions.ts", ["spec-versions:insert"]],
  ["lib/old-name.ts", ["features:legacy"]],
]);

describe("impact-v1 逐文件分类", () => {
  it.each([
    ["README.md", "no_behavior", "document"],
    ["docs/local-snapshot.md", "no_behavior", "document"],
    ["tests/patch-scan.test.ts", "no_detected_behavior_change", "test_code"],
    ["app/api/x/__tests__/route.test.ts", "no_detected_behavior_change", "test_code"],
    [".github/workflows/ci.yml", "no_detected_behavior_change", "ci_config"],
    ["Makefile", "no_detected_behavior_change", "ci_config"],
    [".gitignore", "no_detected_behavior_change", "editor_or_vcs_config"],
    ["docs/.gitattributes", "no_detected_behavior_change", "editor_or_vcs_config"],
    ["package-lock.json", "global_unbounded", "dependency_manifest"],
    ["app/package.json", "global_unbounded", "dependency_manifest"],
    ["services/api/go.mod", "global_unbounded", "dependency_manifest"],
    ["migrations/090_add_gift_wallet.sql", "global_unbounded", "schema_migration"],
    ["superset/migrations/versions/2026_11_01.py", "global_unbounded", "schema_migration"],
    ["prisma/schema.prisma", "global_unbounded", "schema_migration"],
    [".env.production", "global_unbounded", "runtime_config"],
    ["Dockerfile", "global_unbounded", "runtime_config"],
    ["docker-compose.prod.yml", "global_unbounded", "runtime_config"],
    ["next.config.ts", "global_unbounded", "runtime_config"],
    ["middleware.ts", "global_unbounded", "assembly_point"],
    ["src/proxy.ts", "global_unbounded", "assembly_point"],
    ["src/instrumentation.ts", "global_unbounded", "assembly_point"],
    ["billing/middleware.py", "global_unbounded", "assembly_point"],
    ["lib/code-hosting/registry.ts", "global_unbounded", "assembly_point"],
    ["app/(app)/layout.tsx", "global_unbounded", "assembly_point"],
    ["django_app/urls.py", "global_unbounded", "assembly_point"],
    ["cmd/server/main.go", "global_unbounded", "assembly_point"],
    ["shared/utils.ts", "global_unbounded", "shared_module"],
    ["src/common/http.ts", "global_unbounded", "shared_module"],
    ["lib/index.ts", "global_unbounded", "shared_module"],
    ["lib/types.ts", "global_unbounded", "shared_module"],
    ["superset/models/core.py", "global_unbounded", "schema_migration"],
  ] as const)("%s → %s / %s", (path, classification, reason) => {
    expect(classifyFile(file({ path }), new Map())).toMatchObject({ classification, reason });
  });

  it("keeps ordinary implementation files out of the global rules", () => {
    for (const path of ["lib/analysis.ts", "app/api/products/route.ts", "app/page.tsx", "components/CommonButton.tsx", "components/container.tsx", "lib/code-hosting/types.ts", "lib/proxy.ts"]) {
      expect(classifyFile(file({ path }), new Map()).classification, path).toBe("direct");
    }
  });

  it("takes the most conservative rule when a path matches several", () => {
    expect(classifyFile(file({ path: "shared/__tests__/utils.test.ts" }), index)).toMatchObject({
      classification: "global_unbounded",
      reason: "shared_module",
    });
    expect(classifyFile(file({ path: "migrations/README.md" }), index)).toMatchObject({
      classification: "global_unbounded",
      reason: "schema_migration",
    });
  });

  it("marks an indexed implementation file as direct with the features it proves", () => {
    expect(classifyFile(file({ path: "lib/analysis.ts" }), index)).toEqual({
      path: "lib/analysis.ts",
      oldPath: null,
      status: "modified",
      classification: "direct",
      reason: "indexed_implementation",
      directFeatureKeys: ["analysis:run", "analysis:save"],
    });
  });

  it("tells an indexed file apart from an unindexed one even when it proves exactly one feature", () => {
    const singleKeyIndex = new Map([["lib/one.ts", ["only:feature"]]]);
    expect(classifyFile(file({ path: "lib/one.ts" }), singleKeyIndex)).toMatchObject({ classification: "direct", reason: "indexed_implementation", directFeatureKeys: ["only:feature"] });
    expect(classifyFile(file({ path: "lib/two.ts" }), singleKeyIndex)).toMatchObject({ classification: "direct", reason: "unindexed_implementation_file", directFeatureKeys: [] });
  });

  it("treats a new implementation file that hits no index entry as a direct candidate", () => {
    expect(classifyFile(file({ path: "lib/brand-new.ts", status: "added", oldPath: null, oldBlobSha: null }), index)).toMatchObject({
      classification: "direct",
      reason: "unindexed_implementation_file",
      directFeatureKeys: [],
    });
  });

  it("does not re-analyze an implementation file whose patch is comment-only", () => {
    expect(classifyFile(file({ path: "lib/analysis.ts", patch: COMMENT_ONLY_PATCH }), index)).toMatchObject({
      classification: "no_behavior",
      reason: "comment_or_format_only",
    });
  });

  it("stays conservative when the patch is missing or too long to trust", () => {
    expect(classifyFile(file({ path: "lib/analysis.ts", patch: null }), index).classification).toBe("direct");
    expect(classifyFile(file({ path: "lib/analysis.ts", patch: `${COMMENT_ONLY_PATCH}// ${"x".repeat(4100)}` }), index).classification).toBe("direct");
  });

  it("maps a pure rename to both paths without asking for re-analysis", () => {
    const sameBlob = "c".repeat(40);
    expect(
      classifyFile(file({ path: "lib/new-name.ts", oldPath: "lib/analysis.ts", status: "renamed", oldBlobSha: sameBlob, newBlobSha: sameBlob, patch: null }), index),
    ).toEqual({
      path: "lib/new-name.ts",
      oldPath: "lib/analysis.ts",
      status: "renamed",
      classification: "no_detected_behavior_change",
      reason: "pure_rename",
      reanchorsTo: "lib/analysis.ts",
    });
  });

  it("keeps a global rule ahead of a pure rename", () => {
    const sameBlob = "c".repeat(40);
    expect(
      classifyFile(file({ path: "proxy.ts", oldPath: "middleware.ts", status: "renamed", oldBlobSha: sameBlob, newBlobSha: sameBlob, patch: null }), index),
    ).toMatchObject({ classification: "global_unbounded", reason: "assembly_point" });
  });

  it("re-analyzes both sides of a rename that also changes content", () => {
    expect(classifyFile(file({ path: "lib/spec-versions.ts", oldPath: "lib/old-name.ts", status: "renamed" }), index)).toMatchObject({
      classification: "direct",
      reason: "indexed_implementation",
      directFeatureKeys: ["features:legacy", "spec-versions:insert"],
    });
  });

  it("looks up the old path when a file is deleted", () => {
    expect(classifyFile(file({ path: "lib/old-name.ts", status: "deleted", newBlobSha: null, newMode: null }), index)).toMatchObject({
      classification: "direct",
      directFeatureKeys: ["features:legacy"],
    });
  });

  it.each([
    ["docs/arch.png", true],
    ["public/logo.svg", false],
    ["assets/font.woff2", true],
  ])("treats the static asset %s as a non-behavioral asset", (path, binary) => {
    expect(classifyFile(file({ path, binary }), index)).toMatchObject({ classification: "no_detected_behavior_change", reason: "static_asset" });
  });

  it("keeps treating a renamed binary asset as an asset when its new name loses the asset extension", () => {
    const sameBlob = "c".repeat(40);
    const renamedAsset = file({ path: "assets/logo", oldPath: "assets/logo.png", status: "renamed", oldBlobSha: sameBlob, newBlobSha: sameBlob, binary: true, patch: null });
    expect(classifyFile(renamedAsset, index)).toMatchObject({ classification: "no_detected_behavior_change", reason: "static_asset" });
  });

  it("leaves other binary content unknown instead of guessing", () => {
    expect(classifyFile(file({ path: "assets/blob.bin", binary: true }), index)).toMatchObject({ classification: "unknown", reason: "binary_content" });
    expect(classifyFile(file({ path: "docs/blob.bin", binary: true }), index)).toMatchObject({
      classification: "no_detected_behavior_change",
      reason: "static_asset",
    });
  });

  it("treats a mode-only change as detected but not behavioral (diff contract)", () => {
    const sameBlob = "c".repeat(40);
    expect(classifyFile(file({ path: "scripts/run.sh", oldMode: "100644", newMode: "100755", oldBlobSha: sameBlob, newBlobSha: sameBlob, patch: "" }), index)).toMatchObject({
      classification: "no_detected_behavior_change",
      reason: "mode_change",
    });
  });

  it("forces full resync when a symlink or submodule changes (diff contract)", () => {
    expect(classifyFile(file({ path: "link.ts", status: "added", oldMode: null, oldBlobSha: null, newMode: "120000" }), index)).toMatchObject({
      classification: "global_unbounded",
      reason: "symlink",
    });
    expect(classifyFile(file({ path: "sub/mod", status: "modified", newMode: "160000" }), index)).toMatchObject({
      classification: "global_unbounded",
      reason: "submodule",
    });
    expect(classifyFile(file({ path: "link.ts", status: "deleted", oldMode: "120000", newMode: null, newBlobSha: null }), index)).toMatchObject({
      classification: "global_unbounded",
      reason: "symlink",
    });
  });

  it("re-analyzes a changed file whose patch git could not render", () => {
    expect(classifyFile(file({ path: "lib/analysis.ts", patch: "diff --git a/x b/x\nindex 111..222 100644\nBinary files a/x and b/x differ\n" }), index).classification).toBe("direct");
  });
});

describe("impact-v1 窗口归宿", () => {
  it("reports a docs-only window as no_behavior with nothing to re-analyze", () => {
    expect(classifyWindow([file({ path: "README.md" })], index)).toEqual({
      outcome: "no_behavior",
      files: [expect.objectContaining({ classification: "no_behavior" })],
      globalReasons: [],
      directFeatureKeys: [],
      requiredFeatureKeys: [],
    });
  });

  it("prefers no_detected_behavior_change over no_behavior when both appear", () => {
    expect(classifyWindow([file({ path: "README.md" }), file({ path: "tests/a.test.ts" })], index).outcome).toBe("no_detected_behavior_change");
  });

  it("collects the distinct features a direct window must re-analyze", () => {
    const window = classifyWindow([file({ path: "lib/spec-versions.ts" }), file({ path: "lib/analysis.ts" }), file({ path: "docs/new.md" })], index);
    expect(window.outcome).toBe("direct");
    expect(window.directFeatureKeys).toEqual(["analysis:run", "analysis:save", "spec-versions:insert"]);
    expect(window.requiredFeatureKeys).toEqual(["analysis:run", "analysis:save", "spec-versions:insert"]);
  });

  it("lets one global file force the whole window to full resync and names every reason", () => {
    const window = classifyWindow([file({ path: "lib/analysis.ts" }), file({ path: "package-lock.json" }), file({ path: "migrations/1.sql" }), file({ path: "Dockerfile" })], index);
    expect(window.outcome).toBe("global_unbounded");
    expect(window.globalReasons).toEqual(["dependency_manifest", "runtime_config", "schema_migration"]);
    expect(window.files.map((entry) => entry.classification)).toEqual(["direct", "global_unbounded", "global_unbounded", "global_unbounded"]);
  });

  it("ranks unknown above direct but below global", () => {
    expect(classifyWindow([file({ path: "lib/analysis.ts" }), file({ path: "assets/blob.bin", binary: true })], index).outcome).toBe("unknown");
    expect(classifyWindow([file({ path: "assets/blob.bin", binary: true }), file({ path: ".env" })], index).outcome).toBe("global_unbounded");
  });

  it("treats an empty window as no_behavior", () => {
    expect(classifyWindow([], index).outcome).toBe("no_behavior");
  });

  it("publishes its rules version", () => {
    expect(IMPACT_RULES_VERSION).toBe("impact-v1");
  });
});
