import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueAnalysis, runAnalysis } from "../lib/analysis";
import { analyzeWithAI } from "../lib/ai";
import { getRemoteAnalysisSources } from "../lib/remote-analysis";
import { generateRepositoryArchitectureVersion } from "../lib/architecture-version";

const execute = vi.fn();
const readLines = vi.fn();
const listDir = vi.fn();
const openArchitectureIndex = vi.fn();
const connection = {
  execute: vi.fn(),
  beginTransaction: vi.fn(async () => undefined),
  commit: vi.fn(async () => undefined),
  rollback: vi.fn(async () => undefined),
  release: vi.fn(),
};
const adapter = {
  provider: "github" as const,
  getRepository: vi.fn(),
  getChangeContext: vi.fn(),
};

vi.mock("../lib/db", () => ({ getDb: () => ({ execute, getConnection: async () => connection }) }));
vi.mock("../lib/code-hosting", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/code-hosting")>(),
  resolveAnalysisTarget: vi.fn((run) => ({
    adapter,
    access: { connectionId: run.connectionId, organizationId: run.organizationId },
    product: { id: run.productId, slug: run.productSlug, name: run.productName },
  })),
}));
vi.mock("../lib/ai", () => ({ analyzeWithAI: vi.fn() }));
vi.mock("../lib/notifications", () => ({ deliverAnalysisNotifications: vi.fn(async () => undefined) }));
vi.mock("../lib/remote-analysis", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/remote-analysis")>(), getRemoteAnalysisSources: vi.fn() }));
vi.mock("../lib/spec-versions", () => ({ insertSpecVersion: vi.fn(async () => 44), loadPreviousFeatureNames: vi.fn(async () => ["统一登录", "支付", "规格导出"]) }));
vi.mock("../lib/architecture-version", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/architecture-version")>(), generateRepositoryArchitectureVersion: vi.fn(async () => ({ status: "accepted", errorMessage: null })) }));

const run = {
  id: 8,
  repositoryId: 3,
  productId: 4,
  owner: "gzhanlei",
  name: "radar",
  beforeSha: null,
  afterSha: "sha-after",
  connectionId: 42,
  provider: "github",
  organizationId: 7,
  productSlug: "radar",
  productName: "CoDelphi",
};

let runRows: unknown[] = [];
let sourceRows: unknown[] = [];
let existingRunRows: unknown[] = [];
let loadError: unknown;

describe("analysis orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runRows = [run];
    sourceRows = [];
    existingRunRows = [];
    loadError = undefined;
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) {
        if (loadError) throw loadError;
        return [runRows];
      }
      if (sql.includes("source_roots")) return [sourceRows];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 55 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }]];
      return [{}];
    });
    connection.execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ?")) return [[{ id: 8 }]];
      if (sql.includes("SELECT id FROM releases")) return [[{ id: 6 }]];
      if (sql.includes("SELECT COUNT")) return [[{ count: 1 }]];
      if (sql.includes("FROM spec_features sf")) return [[]];
      if (sql.includes("FROM spec_changes")) return [[]];
      return [{}];
    });
    adapter.getRepository.mockResolvedValue({ owner: "gzhanlei", name: "radar", defaultBranch: "main" });
    adapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "https://github.com/commit/sha", files: [] });
    vi.mocked(getRemoteAnalysisSources).mockResolvedValue({ sources: [], slice: { files: [{ path: "lib/db.ts" }] }, index: { readLines, listDir }, openArchitectureIndex } as never);
    openArchitectureIndex.mockReset().mockResolvedValue({ readLines, listDir });
    listDir.mockResolvedValue({ status: "indexed", truncated: false, entries: [{ path: "lib/db.ts", type: "blob" }, { path: "lib/ai.ts", type: "blob" }] });
    readLines.mockImplementation(async (request) => ({ startLine: 1, endLine: 1, lineCount: 1, byteSize: 100, lines: [`${request.path} complete evidence`] }));
    vi.mocked(analyzeWithAI).mockResolvedValue({ product: { description: "代码驱动的产品知识与变更中心。", evidence: [{ path: "lib/db.ts", startLine: 1 }] }, release: { title: "v1", summary: "summary" }, features: [], changes: [] });
  });

  it("reuses an existing queued run", async () => {
    existingRunRows = [{ id: 12 }];
    await expect(queueAnalysis(3, null, "sha-after", "manual")).resolves.toBe(12);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("inserts a new queued run", async () => {
    await expect(queueAnalysis(3, null, "sha-after", "manual")).resolves.toBe(55);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO analysis_runs"), [3, "manual", null, "sha-after"]);
  });

  it("returns the winning run when a concurrent queue inserts the same sha", async () => {
    let selectCount = 0;
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) {
        selectCount += 1;
        return selectCount === 1 ? [[]] : [[{ id: 77 }]];
      }
      if (sql.includes("INSERT INTO analysis_runs")) {
        throw Object.assign(new Error("Duplicate entry '3-sha-after-1' for key 'analysis_runs_active_unique'"), { code: "ER_DUP_ENTRY" });
      }
      return [{}];
    });
    await expect(queueAnalysis(3, null, "sha-after", "manual")).resolves.toBe(77);
  });

  it("ignores an analysis run that no longer needs work", async () => {
    runRows = [];
    await runAnalysis(8);
    expect(adapter.getRepository).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("uses shared scope when no source roots are stored and commits the result", async () => {
    await runAnalysis(8);
    expect(getRemoteAnalysisSources).toHaveBeenCalledWith(expect.objectContaining({
      provider: "github",
      access: { connectionId: 42, organizationId: 7 },
      scopeRoots: [{ path: "", role: "shared" }],
    }), expect.anything());
    expect(vi.mocked(analyzeWithAI).mock.calls[0][2]).toEqual({ previousFeatureNames: ["统一登录", "支付", "规格导出"], affectedFeatureNames: undefined });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
  });

  it("uses persisted source roots when present", async () => {
    sourceRows = [{ sourceRoots: [{ path: "apps/web", role: "web" }] }];
    await runAnalysis(8);
    expect(getRemoteAnalysisSources).toHaveBeenCalledWith(expect.objectContaining({ scopeRoots: [{ path: "apps/web", role: "web" }] }), expect.anything());
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("saves the spec without opening an architecture index or generating a diagram", async () => {
    await runAnalysis(8);
    expect(openArchitectureIndex).not.toHaveBeenCalled();
    expect(generateRepositoryArchitectureVersion).not.toHaveBeenCalled();
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("fills only a blank product description with traceable AI output", async () => {
    await runAnalysis(8);
    const update = connection.execute.mock.calls.find(([sql]) => String(sql).includes("UPDATE products SET description = ?"));
    expect(update?.[0]).toContain("description_source = 'generated'");
    expect(update?.[0]).toContain("WHERE id = ? AND description = ''");
    expect(update?.[1]).toEqual(["代码驱动的产品知识与变更中心。", JSON.stringify([{ path: "lib/db.ts", startLine: 1 }]), 4]);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("runs a shadow full extraction after a successful incremental analysis", async () => {
    runRows = [{ ...run, analyzeMode: "incremental" }];
    sourceRows = [];
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [sourceRows];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 55 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }, { name: "支付" }, { name: "规格导出" }]];
      if (sql.includes("FROM spec_file_index i")) return [[{ stableKey: "统一登录", name: "统一登录" }]];
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/auth.ts", status: "modified", patch: "" }] });
    vi.stubEnv("INCREMENTAL_SHADOW", "true");
    try {
      await runAnalysis(8);
      expect(analyzeWithAI).toHaveBeenCalledTimes(2);
      const scopeCall = vi.mocked(analyzeWithAI).mock.calls[0][2] as { affectedFeatureNames?: string[] };
      const shadowCall = vi.mocked(analyzeWithAI).mock.calls[1][2] as { affectedFeatureNames?: string[] };
      expect(scopeCall.affectedFeatureNames).toEqual(["统一登录"]);
      expect(shadowCall.affectedFeatureNames).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("records a readable failure when loading the run fails", async () => {
    loadError = new Error("load failed");
    await runAnalysis(8);
    const [stored] = execute.mock.calls.find(([sql]) => String(sql).includes("status = 'failed'"))?.[1] as unknown[];
    expect(String(stored).startsWith("load failed\n")).toBe(true);
  });

  it("records a fallback failure for non-Error rejections", async () => {
    loadError = "denied";
    await runAnalysis(8);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), ["Unknown analysis error", 8]);
  });
});
