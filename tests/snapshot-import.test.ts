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

describe("importSnapshotArtifact 编排（遮蔽 bug 回归：features 必须落在 products 真实 insertId 上）", () => {
  it("inserts scenarios against the created product's real id, not a shadowed zero", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const execute = (async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith("INSERT INTO products")) return [{ insertId: 77 }];
      if (sql.startsWith("INSERT INTO features")) return [{ insertId: 501 }];
      return [[]]; // 所有 SELECT：无幂等命中、无既有仓库、slug 可用
    }) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    const artifact = JSON.parse(JSON.stringify(validArtifact));
    const receipt = await importSnapshotArtifact(
      { execute, currentContractVersion: "1.0.0", organizationId: 2 },
      artifact,
    );
    expect(receipt.productId).toBe(77);
    const scenarioCall = calls.find((call) => call.sql.startsWith("INSERT INTO scenarios"))!;
    expect(scenarioCall.params[0]).toBe(501); // 不是 0 / NaN（variable shadowing 回归）
    expect(receipt.scenariosImported).toBe(1);
  });
});

describe("importSnapshotArtifact 分支覆盖（resolveTargetProduct 三路径）", () => {
  const artifact = () => JSON.parse(JSON.stringify(validArtifact));
  const fakeDeps = (script: (sql: string) => unknown) => ({
    execute: (async (sql: string) => script(String(sql))) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>,
    currentContractVersion: "1.0.0",
    organizationId: 2,
  });

  it("reuses an empty product bound to the origin repo without inserting a new product", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const calls: string[] = [];
    const deps = fakeDeps((sql) => {
      calls.push(String(sql));
      if (String(sql).includes("seeded_snapshot_sha = ?")) return [[]];
      if (String(sql).includes("FROM repositories r JOIN products p")) return [[{ productId: 55, slug: "sample-repo", activeFeatures: 0 }]];
      return [[]];
    });
    const receipt = await importSnapshotArtifact(deps, artifact());
    expect(receipt).toMatchObject({ productId: 55, mode: "reuse_empty_product", binding: "existing" });
    expect(calls.some((sql) => sql.startsWith("INSERT INTO products"))).toBe(false);
  });

  it("rejects with product_has_content when the origin product already has ledger content", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const deps = fakeDeps((sql) => {
      if (sql.includes("seeded_snapshot_sha = ?")) return [[]];
      if (sql.includes("FROM repositories r JOIN products p")) return [[{ productId: 55, slug: "sample-repo", activeFeatures: 7 }]];
      return [[]];
    });
    try {
      await importSnapshotArtifact(deps, artifact());
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("product_has_content");
    }
  });

  it("registers the repository row when the origin is new (created binding)", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    vi.fn(); // 保持 vi 引用（顶部已导入）
    const calls: string[] = [];
    const deps = fakeDeps((sql) => {
      calls.push(String(sql));
      if (sql.startsWith("INSERT INTO repositories")) return [{ insertId: 900 }];
      if (sql.startsWith("INSERT INTO products")) return [{ insertId: 77 }];
      if (sql.startsWith("INSERT INTO features")) return [{ insertId: 501 }];
      return [[]];
    });
    const probeRemote = vi.fn().mockResolvedValue({ state: "reachable", changedFiles: 2 });
    const receipt = await importSnapshotArtifact({ ...deps, probeRemote }, artifact());
    expect(receipt.binding).toBe("created");
    expect(probeRemote).toHaveBeenCalled();
    expect(receipt.remote).toEqual({ state: "reachable", changedFiles: 2 });
    const repoCall = calls.findIndex((sql) => sql.startsWith("INSERT INTO repositories"));
    expect(repoCall).toBeGreaterThan(-1);
    expect(receipt.productId).toBe(77);
  });
});

describe("importSnapshotArtifact 产品简介随导入落库", () => {
  it("writes description + evidence only when the product description is empty", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const execute = (async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.startsWith("INSERT INTO products")) return [{ insertId: 77 }];
      if (sql.startsWith("INSERT INTO features")) return [{ insertId: 501 }];
      return [[]];
    }) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    const artifact = JSON.parse(JSON.stringify(validArtifact));
    artifact.product = { description: "给销售每一次沟通建档的产品。", evidence: [{ path: "lib/app.ts", startLine: 12 }] };
    await importSnapshotArtifact({ execute, currentContractVersion: "1.0.0", organizationId: 2, probeRemote: async () => ({ state: "unverified" }) }, artifact);
    const descCall = calls.find((call) => call.sql.includes("UPDATE products SET description"));
    expect(descCall).toBeDefined();
    expect(descCall!.sql).toContain("AND description = ''");
    expect(descCall!.sql).toContain("description_source = 'ai_snapshot_import'");
    expect(descCall!.params[0]).toBe("给销售每一次沟通建档的产品。");
  });
});

describe("importSnapshotArtifact 幂等回归（refactor 曾丢早退）", () => {
  it("performs zero inserts on idempotent re-import (structural, beyond UNIQUE fallback)", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const calls: string[] = [];
    const execute = (async (sql: string) => {
      calls.push(String(sql));
      if (String(sql).includes("seeded_snapshot_sha = ?")) return [[{ id: 20, slug: "airecord", seededTreeSha: "b".repeat(40) }]];
      return [[]];
    }) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    const artifact = JSON.parse(JSON.stringify(validArtifact));
    const receipt = await importSnapshotArtifact({ execute, currentContractVersion: "1.0.0", organizationId: 2 }, artifact);
    expect(receipt.mode).toBe("idempotent");
    expect(receipt.featuresImported).toBe(0);
    expect(calls.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
  });
});
