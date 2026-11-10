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

  it("excludes CI/infrastructure paths regardless of patch content (BM-8)", () => {
    const files = [
      { path: ".github/labeler.yml", status: "modified", patch: "+  i18n:polish:" },
      { path: ".github/workflows/ci.yml", status: "modified", patch: "+  - run: npm test" },
      { path: "dev/check_license.sh", status: "modified", patch: "+curl --retry 5" },
      { path: "superset-frontend/package-lock.json", status: "modified", patch: "+      \"fastmcp\": \"4.1.4\"" },
      { path: "superset/config.py", status: "modified", patch: "+FLAG = True" },
      { path: ".gitlab-ci.yml", status: "modified", patch: "+  script: make" },
    ];
    const behavioral = behavioralChangePaths(files);
    expect(behavioral.has(".github/labeler.yml")).toBe(false);
    expect(behavioral.has(".github/workflows/ci.yml")).toBe(false);
    // 保守边界：.sh 脚本不排除（部署脚本可能承载行为），lockfile 与 CI 配置排除
    expect(behavioral.has("dev/check_license.sh")).toBe(true);
    expect(behavioral.has("superset-frontend/package-lock.json")).toBe(false);
    expect(behavioral.has("superset/config.py")).toBe(true);
    expect(behavioral.has(".gitlab-ci.yml")).toBe(false);
  });

  it("treats a formatter reflow as non-behavioral — the real M8 patch shape (BM-9)", () => {
    // 3807a4d743 真实形态：多行参数体折叠为单行，去空白后内容逐字符一致
    const files = [
      {
        path: "superset-frontend/src/dashboard/components/filterscope/FilterScopeSelector.tsx",
        status: "modified",
        patch: [
          "@@ -503,11 +503,10 @@ export default function FilterScopeSelector({",
          "-  const [checkedFilterFields, setCheckedFilterFields] = useState<string[]>(",
          "-    () =>",
          "-      initialized.showSelector",
          "-        ? initialized.initialState.checkedFilterFields",
          "-        : [],",
          "+  const [checkedFilterFields, setCheckedFilterFields] = useState<string[]>(() =>",
          "+    initialized.showSelector",
          "+      ? initialized.initialState.checkedFilterFields",
          "+      : [],",
          "  );",
        ].join("\n"),
      },
    ];
    expect(behavioralChangePaths(files).size).toBe(0);
  });

  it("treats a pure line reorder as non-behavioral (BM-9)", () => {
    const files = [
      {
        path: "superset/utils/order.ts",
        status: "modified",
        patch: [
          "@@ -1,5 +1,5 @@",
          "-const a = computeA();",
          "-const b = computeB();",
          "+const b = computeB();",
          "+const a = computeA();",
        ].join("\n"),
      },
    ];
    expect(behavioralChangePaths(files).size).toBe(0);
  });

  it("keeps semantic changes behavioral despite identical token multisets (BM-9 保守边界)", () => {
    const files = [
      // 操作数交换：token multiset 相同但行为翻转
      { path: "superset/utils/math.ts", status: "modified", patch: "-const delta = b - a;\n+const delta = a - b;" },
      // 运算符替换：去空白串不同
      { path: "superset/utils/fallback.ts", status: "modified", patch: "-const v = a || b;\n+const v = a ?? b;" },
      // optional chaining：标点差异被保留
      { path: "superset/utils/access.ts", status: "modified", patch: "-const n = a.b;\n+const n = a?.b;" },
      // 纯新增代码
      { path: "superset/utils/new.ts", status: "modified", patch: "+const fresh = 1;" },
    ];
    const behavioral = behavioralChangePaths(files);
    expect(behavioral.size).toBe(4);
  });
});
