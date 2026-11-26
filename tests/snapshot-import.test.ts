import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildImportedPresentation, ImportValidationError, parseGithubOrigin, slugifyRepoName, validateImportArtifact } from "../lib/snapshot-import";
import { presentationFingerprint } from "../lib/product-presentation";

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
  it("refuses a snapshot that carries source excerpts before anything else looks at it, and says to upgrade", () => {
    // 摘录不在 schema 的声明里，解析之后就被剥掉。所以这一步必须排在 schema 之前（修订稿 §4.2）。
    const withSnippets = { ...validArtifact, evidenceSnippets: [{ id: "evidence-1", path: "lib/a.ts", lines: [{ number: 1, text: "export const a = 1;" }] }] };
    let caught: unknown;
    try {
      validateImportArtifact(withSnippets, "1.0.0");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ImportValidationError);
    expect((caught as ImportValidationError).code).toBe("artifact_contains_source");
    expect((caught as ImportValidationError).message).toMatch(/upgrade/);
    // 摘录为空的快照和以前一样可以导入。
    expect(() => validateImportArtifact({ ...validArtifact, evidenceSnippets: [] }, "1.0.0")).not.toThrow();
    // 新的提案契约（没有摘录字段）不受影响：这不是快照导入的形状，照旧按快照的 schema 报错，而不是报「带源码」。
    expect(() => validateImportArtifact({ ...validArtifact, evidenceSnippets: "not an array" }, "1.0.0")).not.toThrow();
  });

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

describe("importSnapshotArtifact 理解层随导入落库（migration 083）", () => {
  /** 两个功能：统一登录（1 条 happy）、发布稿（1 条 happy + 1 条 edge）。 */
  const withPresentation = () => {
    const artifact = JSON.parse(JSON.stringify(validArtifact));
    artifact.features.push({
      name: "发布稿",
      summary: "对外发布说明",
      scenarios: [
        { reference: "HP-1", context: "有新发布", action: "点击发布", outcome: "生成分享页", category: "happy", evidence: [{ path: "lib/notes.ts", startLine: 3 }] },
        { reference: "EC-1", context: "未登录", action: "点击发布", outcome: "提示登录", category: "edge", evidence: [{ path: "lib/notes.ts", startLine: 9 }] },
      ],
    });
    artifact.presentation = {
      tagline: "一句话说明产品",
      coreCapabilities: [
        { name: "账户与发布", summary: "登录后对外发布", featureNames: ["统一登录", "发布稿"], scenarioRefs: [] },
        { name: "成员都没导入", summary: "s", featureNames: ["不存在的功能"], scenarioRefs: [] },
      ],
      journeys: [
        { name: "登录后发布", steps: [{ featureName: "统一登录", reference: "HP-1" }, { featureName: "发布稿", reference: "HP-1" }] },
        { name: "引用了 edge 场景", steps: [{ featureName: "统一登录", reference: "HP-1" }, { featureName: "发布稿", reference: "EC-1" }] },
        { name: "引用了未导入的场景", steps: [{ featureName: "统一登录", reference: "HP-1" }, { featureName: "不存在的功能", reference: "HP-1" }] },
      ],
      concepts: [{ name: "概念不随导入", summary: "s", scenarioRefs: [], relations: [] }],
    };
    return artifact;
  };
  const recordingDeps = (onExecute?: (sql: string) => unknown) => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const execute = (async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const scripted = onExecute?.(sql);
      if (scripted !== undefined) return scripted;
      if (sql.startsWith("INSERT INTO products")) return [{ insertId: 77 }];
      if (sql.startsWith("INSERT INTO features")) return [{ insertId: 501 }];
      return [[]];
    }) as unknown as (sql: string, params?: unknown[]) => Promise<unknown>;
    return { calls, deps: { execute, currentContractVersion: "1.0.0", organizationId: 2, probeRemote: async () => ({ state: "unverified" as const }) } };
  };

  it("keeps only capabilities and journeys whose references exist in the imported spec", async () => {
    const artifact = withPresentation();
    const payload = buildImportedPresentation(artifact.presentation, validateImportArtifact(artifact, "1.0.0"), "zh-CN");
    expect(payload!.status).toBe("generated");
    expect(payload!.tagline).toBe("一句话说明产品");
    // 成员全部落空的能力分组、引用 edge 场景或未导入场景的旅程逐条丢弃
    expect(payload!.capabilities.map((capability) => [capability.name, capability.featureNames])).toEqual([["账户与发布", ["统一登录", "发布稿"]]]);
    // 旅程按它实际触及的能力打标签：两步都在「账户与发布」里
    expect(payload!.journeys.map((journey) => [journey.name, journey.tier, journey.capabilityNames])).toEqual([["登录后发布", "headline", ["账户与发布"]]]);
    expect(payload!.coverage).toEqual({ featuresTotal: 2, featuresInJourneys: 2, scenariosInJourneys: 2 });
    expect(buildImportedPresentation({ coreCapabilities: "garbage", journeys: 42 }, [], "zh-CN")).toBeNull();
    expect(buildImportedPresentation(null, [], "zh-CN")).toBeNull();
  });

  it("writes the presentation with the import source and a fingerprint equal to the ledger's", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const artifact = withPresentation();
    const { calls, deps } = recordingDeps();
    const receipt = await importSnapshotArtifact(deps, artifact);
    expect(receipt.productId).toBe(77);
    const save = calls.find((call) => call.sql.startsWith("INSERT INTO product_presentations"));
    expect(save).toBeDefined();
    const [productId, specVersionId, language, status, source, tagline, capabilitiesJson, journeysJson] = save!.params;
    expect([productId, specVersionId, language, status, source, tagline]).toEqual([77, null, "zh-CN", "generated", "ai_snapshot_import", "一句话说明产品"]);
    expect(JSON.parse(String(capabilitiesJson))).toEqual([{ name: "账户与发布", summary: "登录后对外发布", featureNames: ["统一登录", "发布稿"] }]);
    expect(JSON.parse(String(journeysJson))).toEqual([{ name: "登录后发布", tier: "headline", capabilityNames: ["账户与发布"], steps: [{ featureName: "统一登录", reference: "HP-1" }, { featureName: "发布稿", reference: "HP-1" }] }]);
    // 指纹与「导入后按库内数据算出的账本指纹」逐字相同：后续分析钩子判定未变化，不会为同一份规格再调模型
    const ledger = {
      language: "zh-CN" as const,
      features: [{ id: 501, name: "统一登录", parentId: null }, { id: 900, name: "发布稿", parentId: null }],
      scenarios: [
        { featureId: 501, reference: "HP-1", category: "happy" },
        { featureId: 900, reference: "HP-1", category: "happy" },
        { featureId: 900, reference: "EC-1", category: "edge" },
      ],
    };
    expect(save!.params[9]).toBe(presentationFingerprint(ledger));
  });

  it("leaves product_presentations untouched when the artifact carries no presentation", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const { calls, deps } = recordingDeps();
    await importSnapshotArtifact(deps, JSON.parse(JSON.stringify(validArtifact)));
    expect(calls.some((call) => call.sql.includes("product_presentations"))).toBe(false);
  });

  it("keeps the import alive when presentation persistence fails", async () => {
    const { importSnapshotArtifact } = await import("../lib/snapshot-import");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps } = recordingDeps((sql) => {
      if (sql.startsWith("INSERT INTO product_presentations")) throw new Error("Table 'product_presentations' doesn't exist");
      return undefined;
    });
    try {
      const receipt = await importSnapshotArtifact(deps, withPresentation());
      expect(receipt).toMatchObject({ productId: 77, featuresImported: 2, scenariosImported: 3 });
      expect(warn).toHaveBeenCalledWith("[snapshot-import] presentation persistence skipped", expect.objectContaining({ productId: 77 }));
    } finally {
      warn.mockRestore();
    }
  });
});
