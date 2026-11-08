import { describe, expect, it } from "vitest";
import { behavioralChangePaths, patchOnlyCommentsOrBlank } from "../lib/patch-scan";

describe("patch-scan 行为性行判定", () => {
  it("treats a JSDoc-only patch as comment-only (superset #1009 mode)", () => {
    const jsdocOnly = [
      "@@ -170,6 +170,13 @@ export class Database {",
      "+/**",
      "+ * Allow a database connection to carry a username with a password or key pair.",
      "+ */",
      "+",
      "+/**",
      "+ * Requires EMBEDDED_SUPERSET.",
      "+ */",
    ].join("\n");
    expect(patchOnlyCommentsOrBlank(jsdocOnly)).toBe(true);
  });

  it("treats code lines as behavioral even mixed with comments", () => {
    const mixed = [
      "@@ -896,14 +908,16 @@ class BaseEngineSpec {",
      "-  const legacy = computeOld(assets);",
      "+  // Removed the legacy computation.",
      "+  const next = computeNew(assets);",
    ].join("\n");
    expect(patchOnlyCommentsOrBlank(mixed)).toBe(false);
  });

  it("resumes to behavioral content after an in-fragment block comment closes", () => {
    const fragment = ["+ * docs inside an unterminated fragment", "+ */ const resumed = 2;"].join("\n");
    expect(patchOnlyCommentsOrBlank(fragment)).toBe(false);
  });

  it("treats removed comment-only lines as non-behavioral", () => {
    expect(patchOnlyCommentsOrBlank(["-// deprecated note", "-/* old block */"].join("\n"))).toBe(true);
  });

  it("is conservative without a patch, on unknown languages, and on oversized patches", () => {
    const files = [
      { path: "superset/views.py", status: "modified", patch: "" },
      { path: "app/widget.rb", status: "modified", patch: "+x = 1" },
      { path: "app/big.ts", status: "modified", patch: `+/* ${"x".repeat(4200)} */` },
    ];
    const behavioral = behavioralChangePaths(files);
    expect(behavioral.size).toBe(3);
  });

  it("classifies python hash comments as non-behavioral and python code as behavioral", () => {
    const files = [
      { path: "superset/config.py", status: "modified", patch: "+# bump pyarrow floor for CVE" },
      { path: "superset/commands/create.py", status: "modified", patch: "+    add_permissions(database)" },
    ];
    const behavioral = behavioralChangePaths(files);
    expect(behavioral.has("superset/config.py")).toBe(false);
    expect(behavioral.has("superset/commands/create.py")).toBe(true);
  });

  it("collects behavioral paths across mixed files", () => {
    const files = [
      { path: "sdk/src/index.ts", status: "modified", patch: "+/** docs */" },
      { path: "sdk/src/guestTokenRefresh.test.ts", status: "added", patch: "+it('refreshes', () => {});" },
      { path: "superset/db_engine_specs/databricks.py", status: "modified", patch: "+    def cancel(self):" },
    ];
    const behavioral = behavioralChangePaths(files);
    expect(behavioral.has("sdk/src/index.ts")).toBe(false);
    // 测试文件按证据分级即非 implementation，不进集合。
    expect(behavioral.has("sdk/src/guestTokenRefresh.test.ts")).toBe(false);
    expect(behavioral.has("superset/db_engine_specs/databricks.py")).toBe(true);
  });
});
