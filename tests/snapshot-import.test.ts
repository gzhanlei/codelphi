import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseGithubOrigin, slugifyRepoName, validateImportArtifact } from "../lib/snapshot-import";

/** BYO 导入校验链（设计 §4.2）：校验失败拒绝、contractVersion 门、引用唯一性、锚点路径卫生。 */

const validArtifact = {
  artifactKind: "codelphi-radar-snapshot",
  exportVersion: 1,
  contractVersion: "1.0.0",
  identity: {
    name: "sample-repo",
    revision: "a".repeat(40),
    treeSha: "b".repeat(40),
    originRemote: "https://github.com/acme/sample-repo",
    workingTreeDirty: false,
    branch: "main",
  },
  language: "zh-CN",
  features: [
    {
      name: "统一登录",
      summary: "OAuth 登录",
      scenarios: [
        { reference: "HP-1", context: "已登录", action: "访问设置页", outcome: "跳转工作台", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 10, endLine: 20 }] },
      ],
    },
  ],
};

describe("validateImportArtifact", () => {
  it("accepts a well-formed artifact and normalizes scenario evidence", () => {
    const features = validateImportArtifact(validArtifact, "1.0.0");
    expect(features).toHaveLength(1);
    expect(features[0].scenarios[0].evidence).toEqual([{ path: "lib/auth.ts", startLine: 10, endLine: 20 }]);
  });

  it("rejects contract version mismatch without schema noise (409 语义)", () => {
    expect(() => validateImportArtifact(validArtifact, "9.9.9")).toThrowError(/contract_version_mismatch|does not match/);
    try {
      validateImportArtifact(validArtifact, "9.9.9");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("contract_version_mismatch");
    }
  });

  it("rejects unknown artifact kinds and bad export versions", () => {
    expect(() => validateImportArtifact({ ...validArtifact, artifactKind: "other" }, "1.0.0")).toThrow();
    expect(() => validateImportArtifact({ ...validArtifact, exportVersion: 2 }, "1.0.0")).toThrow();
  });

  it("rejects absolute or traversal evidence paths", () => {
    const bad = JSON.parse(JSON.stringify(validArtifact));
    bad.features[0].scenarios[0].evidence = [{ path: "/etc/passwd" }];
    expect(() => validateImportArtifact(bad, "1.0.0")).toThrow();
    bad.features[0].scenarios[0].evidence = [{ path: "lib/../../etc/passwd" }];
    expect(() => validateImportArtifact(bad, "1.0.0")).toThrow();
  });

  it("rejects duplicate scenario references within a feature (400 语义)", () => {
    const bad = JSON.parse(JSON.stringify(validArtifact));
    bad.features[0].scenarios.push({ ...bad.features[0].scenarios[0] });
    try {
      validateImportArtifact(bad, "1.0.0");
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("duplicate_reference");
    }
  });
});

describe("slugifyRepoName / parseGithubOrigin", () => {
  it("slugifies repo names and falls back on garbage", () => {
    expect(slugifyRepoName("My Cool Repo")).toBe("my-cool-repo");
    expect(slugifyRepoName("   ")).toBe("imported-repo");
  });

  it("parses https origins and rejects non-github or malformed ones", () => {
    expect(parseGithubOrigin("https://github.com/acme/sample-repo")).toEqual({ owner: "acme", name: "sample-repo" });
    expect(parseGithubOrigin("https://github.com/acme/sample-repo.git")).toEqual({ owner: "acme", name: "sample-repo" });
    expect(parseGithubOrigin("https://gitlab.com/acme/repo")).toBeNull();
    expect(parseGithubOrigin(null)).toBeNull();
  });
});
