import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueAnalysis, runAnalysis } from "../lib/analysis";
import { analyzeWithAI } from "../lib/ai";
import { getRemoteAnalysisSources } from "../lib/remote-analysis";
import { generateRepositoryArchitectureVersion } from "../lib/architecture-version";
import { insertSpecVersion } from "../lib/spec-versions";
import { enqueueRunWithReservation, hasActiveReservation, heartbeat, capture, release, reserveForNewRun } from "../lib/billing/core";

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
vi.mock("../lib/billing/core", () => ({
  enqueueRunWithReservation: vi.fn(async (input: { requestId: string }) => ({ runId: 55, attempt: 1, allocations: [], reused: false, requestId: input.requestId })),
  hasActiveReservation: vi.fn(async () => true),
  heartbeat: vi.fn(async () => ({ renewed: true })),
  capture: vi.fn(async () => ({ runSettlementStatus: "fully_settled" })),
  release: vi.fn(async () => ({ released: true })),
  reserveForNewRun: vi.fn(async () => ({ attempt: 1, allocations: [], reused: false })),
}));
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
const { compareIncrementalShadow } = vi.hoisted(() => ({ compareIncrementalShadow: vi.fn((incremental: { features: Array<{ name: string }>; changes: unknown[] }, _full: unknown) => ({ consistent: true, missingKeys: [] as string[], extraKeys: [] as string[], scenarioDiffs: [] as string[] })) }));
vi.mock("../lib/incremental-shadow", () => ({ compareIncrementalShadow }));
vi.mock("../lib/remote-analysis", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/remote-analysis")>(), getRemoteAnalysisSources: vi.fn() }));
vi.mock("../lib/spec-versions", () => ({ insertSpecVersion: vi.fn(async () => ({ specVersionId: 44, features: [{ name: "统一登录", summary: "s", scenarios: [] }] })), loadPreviousFeatureNames: vi.fn(async () => ["统一登录", "支付", "规格导出"]), loadPreviousSpecText: vi.fn(async () => [{ name: "统一登录", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" }] }]) }));
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

  it("reuses an existing queued run via the enqueue combinator", async () => {
    existingRunRows = [{ id: 12 }];
    vi.mocked(enqueueRunWithReservation).mockResolvedValueOnce({ runId: 12, attempt: null, allocations: [], reused: true });
    await expect(queueAnalysis(3, null, "sha-after", "manual")).resolves.toBe(12);
    expect(vi.mocked(enqueueRunWithReservation)).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  it("enqueues with a fresh reserve request identity and lands the gate in the billing core (contract §9)", async () => {
    await expect(queueAnalysis(3, null, "sha-after", "manual")).resolves.toBe(55);
    const input = vi.mocked(enqueueRunWithReservation).mock.calls[0][0];
    expect(input).toMatchObject({ repositoryId: 3, beforeSha: null, afterSha: "sha-after", trigger: "manual" });
    expect(typeof input.requestId).toBe("string");
    expect(input.requestId.length).toBeGreaterThan(0);
    // 同请求重试复用同一身份；每次新入队生成新 UUID（D13）
    await queueAnalysis(3, null, "sha-after", "manual");
    const second = vi.mocked(enqueueRunWithReservation).mock.calls[1][0];
    expect(second.requestId).not.toBe(input.requestId);
    // run INSERT / 竞争收敛已下沉 billing core（020 + D19），analysis 层不再手写 SQL
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO analysis_runs"), expect.anything());
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
    expect(vi.mocked(analyzeWithAI).mock.calls[0][2]).toEqual({
      previousFeatureNames: ["统一登录", "支付", "规格导出"],
      previousSpec: [{ name: "统一登录", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" }] }],
      affectedFeatureNames: undefined,
      billing: { runId: 8, accountId: null, chargeComponent: "main" },
    });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
  });

  it("re-reserves on entry when no active reservation exists (failed-run retry, contract §6.6)", async () => {
    runRows = [{ ...run, accountId: 7 }];
    vi.mocked(hasActiveReservation).mockResolvedValueOnce(false);
    await runAnalysis(8);
    expect(reserveForNewRun).toHaveBeenCalledWith(8, 7, 1, expect.any(String));
    expect(vi.mocked(capture)).toHaveBeenCalled();
  });

  it("skips reservation when the run has no settled account ownership (defensive path)", async () => {
    runRows = [{ ...run, accountId: null }];
    vi.mocked(hasActiveReservation).mockResolvedValueOnce(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runAnalysis(8);
      expect(reserveForNewRun).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
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
      // 影子对比的对象是 carry-forward 合并后的完整 spec（insertSpecVersion 的返回），
      // 而非增量 AI 的原始输出——原始输出本就只含受影响功能，直接比会恒等失败。
      const compared = compareIncrementalShadow.mock.calls.at(-1)?.[0];
      expect(compared?.features).toEqual([{ name: "统一登录", summary: "s", scenarios: [] }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("falls back to behavioral-set carry-forward when incremental resolution rejects (RC2)", async () => {
    // 生产 run 125（2026-11-08）：宽 diff 受影响占比超 60% 回退全量，160KB 窗口丢场景致规格坍缩 178→83。
    // 回退时按行为变更集（patch-scan）重算受影响面：证据文件无行为性行变更的功能原样沿用。
    runRows = [{ ...run, analyzeMode: "incremental" }];
    execute.mockImplementation(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 55 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }], [{ name: "支付" }], [{ name: "规格导出" }]];
      if (sql.includes("FROM spec_file_index i")) {
        // 第一次调用 = 全部 diff 文件（含 docs/tests）→ 命中 2/3 功能，超 60% 阈值被拒；
        // 第二次调用 = 行为变更集（仅 lib/auth.ts）→ 只命中统一登录。
        const allPaths = (parameters as unknown[]).includes("docs/readme.md");
        return [allPaths
          ? [{ stableKey: "统一登录", name: "统一登录" }, { stableKey: "支付", name: "支付" }]
          : [{ stableKey: "统一登录", name: "统一登录" }]];
      }
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({
      message: "change",
      committedAt: "2026-11-01T00:00:00Z",
      url: "",
      files: [
        { path: "lib/auth.ts", status: "modified", patch: "+ const token = sign(payload);" },
        { path: "docs/readme.md", status: "modified", patch: "+ updated docs" },
        { path: "tests/auth.test.ts", status: "modified", patch: "+ it('works')" },
      ],
    });
    await runAnalysis(8);
    // AI 只重提取行为性触及的功能
    const scopeCall = vi.mocked(analyzeWithAI).mock.calls[0][2] as { affectedFeatureNames?: string[] };
    expect(scopeCall.affectedFeatureNames).toEqual(["统一登录"]);
    // 落库按行为受影响集 carry-forward
    const saved = vi.mocked(insertSpecVersion).mock.calls[0][3] as { affectedKeys?: Set<string> };
    expect(saved.affectedKeys).toEqual(new Set(["统一登录"]));
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("keeps true full mode when the behavioral set maps to no known feature (likely new features)", async () => {
    runRows = [{ ...run, analyzeMode: "incremental" }];
    execute.mockImplementation(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 55 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }]];
      if (sql.includes("FROM spec_file_index i")) return [[]];
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({
      message: "change",
      committedAt: "2026-11-01T00:00:00Z",
      url: "",
      files: [{ path: "lib/new-module.ts", status: "added", patch: "+ export const fresh = true;" }],
    });
    await runAnalysis(8);
    const scopeCall = vi.mocked(analyzeWithAI).mock.calls[0][2] as { affectedFeatureNames?: string[] };
    expect(scopeCall.affectedFeatureNames).toBeUndefined();
    const saved = vi.mocked(insertSpecVersion).mock.calls[0][3] as { affectedKeys?: Set<string> };
    expect(saved.affectedKeys).toBeUndefined();
  });

  it("records a readable failure when loading the run fails", async () => {
    loadError = new Error("load failed");
    await runAnalysis(8);
    const [stored] = execute.mock.calls.find(([sql]) => String(sql).includes("status = 'failed'"))?.[1] as unknown[];
    expect(String(stored).startsWith("load failed\n")).toBe(true);
    // 失败释放（契约 §6.6）：置 failed 后独立调用 release，失败由 sweep 兜底
    expect(vi.mocked(release)).toHaveBeenCalledWith(8, "analysis_failed");
  });

  it("records a fallback failure for non-Error rejections", async () => {
    loadError = "denied";
    await runAnalysis(8);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), ["Unknown analysis error", 8]);
  });
});
