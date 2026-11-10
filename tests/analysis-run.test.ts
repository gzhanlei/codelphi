import { beforeEach, describe, expect, it, vi } from "vitest";
import { queueAnalysis, runAnalysis } from "../lib/analysis";
import { analyzeBehavioralGroup } from "../lib/ai";
import { analyzeWithAI, type AnalysisResult } from "../lib/ai";
import { getPartitionedAnalysisSources, getRemoteAnalysisSources } from "../lib/remote-analysis";
import { generateRepositoryArchitectureVersion } from "../lib/architecture-version";
import { insertSpecVersion } from "../lib/spec-versions";
import { BillingError, enqueueRunWithReservation, hasActiveReservation, heartbeat, capture, release, reserveForNewRun } from "../lib/billing/core";
import { specFeatureKey } from "../lib/spec-diff";

const execute = vi.fn();
const readLines = vi.fn();
const listDir = vi.fn();
const listRoot = vi.fn();
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
  // 真实类：analysis.ts 以 instanceof BillingError 区分「账务拒绝→回 queued」与「真失败→failed」
  BillingError: class BillingError extends Error {
    constructor(public code: string, message: string) {
      super(`[${code}] ${message}`);
    }
  },
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
vi.mock("../lib/ai", () => ({ analyzeWithAI: vi.fn(), analyzeBehavioralGroup: vi.fn() }));
vi.mock("../lib/notifications", () => ({ deliverAnalysisNotifications: vi.fn(async () => undefined) }));
const { compareIncrementalShadow } = vi.hoisted(() => ({ compareIncrementalShadow: vi.fn((incremental: { features: Array<{ name: string }>; changes: unknown[] }, _full: unknown) => ({ consistent: true, missingKeys: [] as string[], extraKeys: [] as string[], scenarioDiffs: [] as string[] })) }));
vi.mock("../lib/incremental-shadow", () => ({ compareIncrementalShadow }));
const { partitionedSourcesMock } = vi.hoisted(() => ({ partitionedSourcesMock: vi.fn() }));
vi.mock("../lib/remote-analysis", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/remote-analysis")>(), getRemoteAnalysisSources: vi.fn(), getPartitionedAnalysisSources: partitionedSourcesMock }));
vi.mock("../lib/spec-versions", () => ({ insertSpecVersion: vi.fn(async () => ({ specVersionId: 44, features: [{ name: "统一登录", summary: "s", scenarios: [] }], collapse: null, featureCollapses: [], misplacedScenarios: [], identityHijacksDropped: 0 })), loadLatestSpecFeatures: vi.fn(async () => ({ specVersionId: 44, features: [{ name: "统一登录", summary: "s", scenarios: [] }] })), loadPreviousFeatureNames: vi.fn(async () => ["统一登录", "支付", "规格导出"]), loadPreviousSpecText: vi.fn(async () => [{ name: "统一登录", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" }] }]) }));
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
    adapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "https://github.com/commit/sha", files: [{ path: "lib/auth.ts", status: "modified", patch: "+export const ok = 1;" }] });
    vi.mocked(getRemoteAnalysisSources).mockResolvedValue({ sources: [], slice: { files: [{ path: "lib/db.ts" }] }, index: { readLines, listDir, listRoot }, openArchitectureIndex } as never);
    // 真全量路径（affectedKeys=null）默认走分区提取：单分区等价旧行为
    partitionedSourcesMock.mockResolvedValue({
      partitions: [{ slice: { files: [{ path: "lib/db.ts" }] }, sources: [] }],
      index: { readLines, listDir, listRoot },
    });
    openArchitectureIndex.mockReset().mockResolvedValue({ readLines, listDir });
    listDir.mockResolvedValue({ status: "indexed", truncated: false, entries: [{ path: "lib/db.ts", type: "blob" }, { path: "lib/ai.ts", type: "blob" }] });
    listRoot.mockResolvedValue({ status: "indexed", truncated: false, entries: [{ path: "lib", type: "tree" }] });
    readLines.mockImplementation(async (request) => ({ startLine: 1, endLine: 1, lineCount: 1, byteSize: 100, lines: [`${request.path} complete evidence`] }));
    vi.mocked(analyzeWithAI).mockResolvedValue({ product: { description: "代码驱动的产品知识与变更中心。", evidence: [{ path: "lib/db.ts", startLine: 1 }] }, release: { title: "v1", summary: "summary" }, features: [], changes: [] });
    vi.mocked(analyzeBehavioralGroup).mockResolvedValue({ product: { description: "枚举", evidence: [{ path: "lib/db.ts", startLine: 1 }] }, release: { title: "", summary: "" }, changes: [], features: [] });
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
    expect(partitionedSourcesMock).toHaveBeenCalledWith(expect.objectContaining({
      provider: "github",
      access: { connectionId: 42, organizationId: 7 },
      scopeRoots: [{ path: "", role: "shared" }],
    }), expect.anything(), expect.objectContaining({ maxPartitions: 6 }));
    // 单分区（默认 mock）行为与旧单窗路径一致：无 affectedFeatureNames
    expect(vi.mocked(analyzeWithAI).mock.calls[0][2]).toEqual({
      previousFeatureNames: ["统一登录", "支付", "规格导出"],
      previousSpec: [{ name: "统一登录", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" }] }],
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
    expect(partitionedSourcesMock).toHaveBeenCalledWith(expect.objectContaining({ scopeRoots: [{ path: "apps/web", role: "web" }] }), expect.anything(), expect.anything());
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

  it("runs the incremental path through the same partitioned extraction as full mode (W0-6)", async () => {
    // W0-6：增量 / RC2-carry 不再单窗——按实现面分片，affectedKeys 语义不变
    runRows = [{ ...run, analyzeMode: "incremental" }];
    partitionedSourcesMock.mockResolvedValue({
      partitions: [
        { slice: { files: [{ path: "lib/auth.ts" }] }, sources: [{ path: "lib/auth.ts", content: "1: auth" }] },
        { slice: { files: [{ path: "lib/export.ts" }] }, sources: [{ path: "lib/export.ts", content: "1: export" }] },
      ],
      index: { readLines, listDir, listRoot },
    });
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 55 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }]];
      if (sql.includes("FROM spec_file_index i")) return [[{ stableKey: "统一登录", name: "统一登录", path: "lib/auth.ts" }]];
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/auth.ts", status: "modified", patch: "+ const token = sign(payload);" }] });
    vi.stubEnv("INCREMENTAL_SHADOW", "true");
    try {
      vi.mocked(analyzeWithAI)
        .mockResolvedValueOnce({ product: { description: "d", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "统一登录", summary: "s1", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never)
        .mockResolvedValueOnce({ product: { description: "d2", evidence: [{ path: "lib/export.ts", startLine: 1 }] }, release: { title: "v2", summary: "s2" }, changes: [], features: [] } as never);
      await runAnalysis(8);
      // 逐趟透传受影响功能集；跨趟命名连续性第二趟看到第一趟产出
      const firstCall = vi.mocked(analyzeWithAI).mock.calls[0][2] as { affectedFeatureNames?: string[]; partition?: { index: number; total: number }; previousFeatureNames?: string[] };
      const secondCall = vi.mocked(analyzeWithAI).mock.calls[1][2] as { affectedFeatureNames?: string[]; partition?: { index: number; total: number }; previousFeatureNames?: string[] };
      expect(firstCall.partition).toEqual({ index: 1, total: 2 });
      expect(firstCall.affectedFeatureNames).toEqual(["统一登录"]);
      expect(secondCall.partition).toEqual({ index: 2, total: 2 });
      expect(secondCall.affectedFeatureNames).toEqual(["统一登录"]);
      expect(secondCall.previousFeatureNames).toContain("统一登录");
      // 合并层产出完整规格，affectedKeys 语义不变（carry-forward 沿用未受影响功能）
      const saved = vi.mocked(insertSpecVersion).mock.calls[0][3] as { affectedKeys?: Set<string> };
      expect(saved.affectedKeys).toEqual(new Set(["统一登录"]));
      const savedResult = vi.mocked(insertSpecVersion).mock.calls[0][2] as AnalysisResult;
      expect(savedResult.features.map((feature) => feature.name)).toEqual(["统一登录"]);
      // 影子对比保持单窗口径：增量多趟后显式取一份单窗切片，不静默用空输入
      expect(getRemoteAnalysisSources).toHaveBeenCalledTimes(1);
      expect(analyzeWithAI).toHaveBeenCalledTimes(3);
      const shadowOptions = vi.mocked(analyzeWithAI).mock.calls[2][2] as { billing?: { chargeComponent?: string }; partition?: unknown };
      expect(shadowOptions.billing?.chargeComponent).toBe("platform_shadow");
      expect(shadowOptions.partition).toBeUndefined();
      expect(connection.commit).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("retries a failed extraction pass once before failing the run (model-drift resilience)", async () => {
    // 模型侧偶发（证据路径幻觉、JSON 键漂移）按趟重试一次；重试调用的 receipt 照常落库
    partitionedSourcesMock.mockResolvedValue({
      partitions: [{ slice: { files: [{ path: "lib/auth.ts" }] }, sources: [{ path: "lib/auth.ts", content: "1: auth" }] }],
      index: { readLines, listDir, listRoot },
    });
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 56 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }]];
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/auth.ts", status: "modified", patch: "+ const token = sign(payload);" }] });
    vi.mocked(analyzeWithAI)
      .mockRejectedValueOnce(new Error("AI returned unknown evidence paths: .github/labeler.yml"))
      .mockResolvedValueOnce({ product: { description: "d", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "统一登录", summary: "s1", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never);
    await expect(runAnalysis(8)).resolves.toBeUndefined();
    // W0-7：窗口 diff 文件路径透传给分区装配（必选）
    expect(partitionedSourcesMock.mock.calls[0][0]).toMatchObject({ diffPaths: ["lib/auth.ts"] });
    // 第一次调用失败、第二次重试成功：run 不再因单趟偶发而作废
    expect(analyzeWithAI).toHaveBeenCalledTimes(2);
    expect(vi.mocked(analyzeWithAI).mock.calls[0][0]).toEqual(vi.mocked(analyzeWithAI).mock.calls[1][0]);
    expect(insertSpecVersion).toHaveBeenCalled();
  });

  // W0-3 / I1 常驻回归（docs/m9-workbench-carry-forward-handoff.md §3）：
  // 工作台层（features active=1 的 upsert 集）必须与版本层（insertSpecVersion 返回的
  // 合并规格）集合等价——下线基准是合并结果而非 AI 原始输出，窄推送不得收缩工作台。
  const previousFeatures = [
    { name: "统一登录", summary: "s", scenarios: [] as never[] },
    { name: "规格导出", summary: "s", scenarios: [] as never[] },
    { name: "人工报告", summary: "s", scenarios: [] as never[] },
  ];
  // 按真实 carry-forward 语义（lib/spec-versions.ts mergeSpecSources）出版本层合并结果：
  // AI 输出 ∪ 上一版中未受影响的功能
  const insertSpecVersionWithCarry = () => {
    const mergedCalls: AnalysisResult["features"][] = [];
    vi.mocked(insertSpecVersion).mockImplementation(async (_connection, _run, result, options) => {
      const affected = options?.affectedKeys;
      const merged = [...result.features];
      for (const feature of previousFeatures) {
        const key = specFeatureKey(feature.name);
        if (affected?.has(key)) continue;
        if (merged.some((item) => specFeatureKey(item.name) === key)) continue;
        merged.push({ ...feature });
      }
      mergedCalls.push(merged);
      return { specVersionId: 44, features: merged, collapse: null, featureCollapses: [], misplacedScenarios: [], identityHijacksDropped: 0 };
    });
    return mergedCalls;
  };
  const workbenchUpsertNames = () => (connection.execute as ReturnType<typeof vi.fn>).mock.calls
    .filter((call: unknown[]) => String(call[0]).includes("INSERT INTO features"))
    .map((call: unknown[]) => (call[1] as unknown[])[1] as string);

  const incrementalSetup = () => {
    runRows = [{ ...run, analyzeMode: "incremental" }];
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 55 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [previousFeatures.map(({ name }) => ({ name }))];
      if (sql.includes("FROM spec_file_index i")) return [[{ stableKey: specFeatureKey("统一登录"), name: "统一登录" }]];
      return [{}];
    });
  };

  it("keeps the workbench layer equivalent to the version layer through multi-pass carry-forward (W0-3, I1)", async () => {
    incrementalSetup();
    partitionedSourcesMock.mockResolvedValue({
      partitions: [
        { slice: { files: [{ path: "lib/auth.ts" }] }, sources: [{ path: "lib/auth.ts", content: "1: auth" }] },
        { slice: { files: [{ path: "lib/export.ts" }] }, sources: [{ path: "lib/export.ts", content: "1: export" }] },
      ],
      index: { readLines, listDir, listRoot },
    });
    adapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/auth.ts", status: "modified", patch: "+ const token = sign(payload);" }] });
    vi.mocked(analyzeWithAI)
      .mockResolvedValueOnce({ product: { description: "d", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "统一登录", summary: "s1", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never)
      .mockResolvedValueOnce({ product: { description: "d2", evidence: [{ path: "lib/export.ts", startLine: 1 }] }, release: { title: "v2", summary: "s2" }, changes: [], features: [{ name: "规格导出", summary: "s2", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o2", category: "happy", evidence: [{ path: "lib/export.ts", startLine: 1 }] }] }] } as never);
    const mergedCalls = insertSpecVersionWithCarry();
    await runAnalysis(8);
    // 版本层：合并结果 = 两趟 AI 输出 + carry 的未受影响功能（人工报告）
    const versionFeatures = mergedCalls[0];
    expect(versionFeatures.map((feature) => feature.name)).toEqual(["统一登录", "规格导出", "人工报告"]);
    // 两层等价：工作台 upsert 集合 == 版本层合并集合，而非收缩为 AI 原始输出
    const names = workbenchUpsertNames();
    expect(new Set(names)).toEqual(new Set(versionFeatures.map((feature) => specFeatureKey(feature.name))));
    // 防命名 churn：不产生重复功能行
    expect(names.length).toBe(new Set(names).size);
  });

  it("does not shrink the workbench when a narrow push follows a wide baseline (W0-3)", async () => {
    // 交接文档 §3 场景：连续多次小步 push，每次只触及同一模块——工作台功能数不得低于基线
    incrementalSetup();
    adapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/auth.ts", status: "modified", patch: "+ const token = sign(payload);" }] });
    vi.mocked(analyzeWithAI).mockResolvedValue({ product: { description: "d", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "统一登录", summary: "s1", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never);
    insertSpecVersionWithCarry();
    for (let push = 0; push < 5; push += 1) {
      (connection.execute as ReturnType<typeof vi.fn>).mockClear();
      await runAnalysis(8);
      const names = workbenchUpsertNames();
      // 每次窄推送后，工作台仍 upsert 基线全部 3 个功能（1 个受影响 + 2 个 carry）
      expect(new Set(names)).toEqual(new Set(["统一登录", "规格导出", "人工报告"].map(specFeatureKey)));
      expect(names.length).toBe(3);
    }
  });

  it("extracts per partition and merges chunk results on the true-full path", async () => {
    // 分区 >1：每趟独立提取（分区上下文 i/N + 跨趟累计命名连续性），合并层出完整规格
    runRows = [run];
    partitionedSourcesMock.mockResolvedValue({
      partitions: [
        { slice: { files: [{ path: "lib/auth.ts" }] }, sources: [{ path: "lib/auth.ts", content: "1: auth" }] },
        { slice: { files: [{ path: "lib/export.ts" }] }, sources: [{ path: "lib/export.ts", content: "1: export" }] },
      ],
      index: { readLines, listDir, listRoot },
    });
    vi.mocked(analyzeWithAI)
      .mockResolvedValueOnce({ product: { description: "d", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "统一登录", summary: "s1", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never)
      .mockResolvedValueOnce({ product: { description: "d2", evidence: [{ path: "lib/export.ts", startLine: 1 }] }, release: { title: "v2", summary: "s2" }, changes: [], features: [{ name: "规格导出", summary: "s2", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o2", category: "happy", evidence: [{ path: "lib/export.ts", startLine: 1 }] }] }] } as never);
    await runAnalysis(8);
    expect(vi.mocked(analyzeWithAI)).toHaveBeenCalledTimes(2);
    const firstCall = vi.mocked(analyzeWithAI).mock.calls[0][2] as { partition?: { index: number; total: number }; previousFeatureNames?: string[] };
    const secondCall = vi.mocked(analyzeWithAI).mock.calls[1][2] as { partition?: { index: number; total: number }; previousFeatureNames?: string[] };
    expect(firstCall.partition).toEqual({ index: 1, total: 2 });
    // 跨趟命名连续性：第二趟看到第一趟产出的功能名
    expect(secondCall.partition).toEqual({ index: 2, total: 2 });
    expect(secondCall.previousFeatureNames).toContain("统一登录");
    // 合并层把两趟功能并入同一份规格喂给 saveResult
    const saved = vi.mocked(insertSpecVersion).mock.calls[0][2] as AnalysisResult;
    expect(saved.features.map((feature) => feature.name)).toEqual(["统一登录", "规格导出"]);
    expect(vi.mocked(capture)).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledOnce();
  });

  it("drops cross-partition evidence citations instead of failing the run (sanitize, 2026-11-10 run 185/186)", async () => {
    // 生产教训：模型引用「真实存在但本趟未读」的文件（相邻目录命名先验），整趟作废会让
    // 其余分区的干净产出陪葬。清洗语义：不可溯源的场景整条剔除并留 warn，可溯源产出保留。
    runRows = [run];
    partitionedSourcesMock.mockResolvedValue({
      partitions: [
        { slice: { files: [{ path: "lib/auth.ts" }] }, sources: [{ path: "lib/auth.ts", content: "1: auth" }] },
        { slice: { files: [{ path: "lib/export.ts" }] }, sources: [{ path: "lib/export.ts", content: "1: export" }] },
      ],
      index: { readLines, listDir, listRoot },
    });
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 58 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }]];
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({ message: "behavioral change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/other.ts", status: "modified", patch: "+export const ok = 1;" }] });
    vi.mocked(analyzeWithAI)
      .mockResolvedValueOnce({ product: { description: "d", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "统一登录", summary: "s1", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never)
      .mockResolvedValueOnce({ product: { description: "d2", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v2", summary: "s2" }, changes: [], features: [{ name: "越权功能", summary: "s2", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never);
    await expect(runAnalysis(8)).resolves.toBeUndefined();
    // 第二趟引用第一趟分区文件（不在其允许集）→ 不可溯源的「越权功能」被剔除；第一趟产出保留
    const savedResult = vi.mocked(insertSpecVersion).mock.calls[0][2] as AnalysisResult;
    expect(savedResult.features.map((feature) => feature.name)).toEqual(["统一登录"]);
    // 第二趟 product.evidence 被清洗为空，但合并只取第一趟 product——不受影响
    expect(savedResult.product.evidence).toHaveLength(1);
  });

  it("enumerates behavioral diff files with targeted per-file extraction (W0-8)", async () => {
    partitionedSourcesMock.mockResolvedValue({
      partitions: [{ slice: { files: [{ path: "lib/auth.ts" }] }, sources: [{ path: "lib/auth.ts", content: "1: auth" }] }],
      index: { readLines, listDir, listRoot },
    });
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 60 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }]];
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({ message: "behavioral change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [
      { path: "lib/auth.ts", status: "modified", patch: "@@ -1,3 +1,5 @@\n+ const skip = true;" },
      { path: "lib/audit.ts", status: "added", patch: "@@ -0,0 +1,2 @@\n+ export const audit = 1;" },
    ] });
    vi.mocked(analyzeWithAI).mockResolvedValue({ product: { description: "d", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "统一登录", summary: "s1", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }] } as never);
    vi.mocked(analyzeBehavioralGroup).mockResolvedValue({ product: { description: "枚举", evidence: [{ path: "lib/audit.ts", startLine: 1 }] }, release: { title: "", summary: "" }, changes: [{ featureName: "审计日志", kind: "added", description: "审计", userImpact: "", evidence: [{ path: "lib/audit.ts", startLine: 1 }] }], features: [{ name: "审计日志", summary: "审计", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/audit.ts", startLine: 2 }] }] }] } as never);
    await expect(runAnalysis(8)).resolves.toBeUndefined();
    // 定向枚举按组调用：组内包含全部行为文件与各自 patch；上下文带既有功能名清单
    const [targets, known] = vi.mocked(analyzeBehavioralGroup).mock.calls[0];
    expect(targets.map((t) => t.path).sort()).toEqual(["lib/audit.ts", "lib/auth.ts"]);
    expect(targets.find((t) => t.path === "lib/auth.ts")?.patch).toContain("const skip");
    expect(known).toContain("统一登录");
    // 枚举产出的功能进入合并规格
    const savedResult = vi.mocked(insertSpecVersion).mock.calls[0][2] as AnalysisResult;
    expect(savedResult.features.map((feature) => feature.name)).toContain("审计日志");
    // R1 完整性账本落库：六维度 + overall
    const ledgerCall = execute.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO analysis_completeness_ledger"));
    expect(ledgerCall).toBeDefined();
    const ledgerParams = ledgerCall![1] as unknown[];
    expect(ledgerParams[0]).toBe(8);
    expect(String(ledgerParams[7])).toMatch(/complete|partial|failed|not_applicable/);
  });

  it("accepts a sanitized-empty pass as a no-change window (collapse detection downstream)", async () => {
    // 文档-only 窗口 + 全幻觉引用 → 清洗后为空：按「无行为变化」接受（既有契约：空版本
    // 由坍缩护栏下游告警），run 不失败、不结算。
    runRows = [run];
    partitionedSourcesMock.mockResolvedValue({
      partitions: [{ slice: { files: [{ path: "lib/auth.ts" }] }, sources: [{ path: "lib/auth.ts", content: "1: auth" }] }],
      index: { readLines, listDir, listRoot },
    });
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN repositories repo")) return [runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ? AND after_sha = ?")) return [existingRunRows];
      if (sql.includes("INSERT INTO analysis_runs")) return [{ insertId: 59 }];
      if (sql.includes("SELECT sf.name FROM spec_features")) return [[{ name: "统一登录" }]];
      return [{}];
    });
    adapter.getChangeContext.mockResolvedValue({ message: "behavioral change", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/auth.ts", status: "modified", patch: "+export const ok = 1;" }] });
    const hallucinated = { product: { description: "d", evidence: [{ path: "lib/invented.ts", startLine: 1 }] }, release: { title: "v1", summary: "s" }, changes: [], features: [{ name: "虚构功能", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/invented.ts", startLine: 1 }] }] }] } as never;
    vi.mocked(analyzeWithAI).mockResolvedValue(hallucinated);
    await expect(runAnalysis(8)).resolves.toBeUndefined();
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("status = 'failed'"))).toBe(false);
    const savedResult = vi.mocked(insertSpecVersion).mock.calls[0][2] as AnalysisResult;
    expect(savedResult.features).toEqual([]);
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

  it("skips extraction and carries the previous spec verbatim on a no-behavioral window (BM-10)", async () => {
    // docs-only 窗口（patch-scan 无行为文件）→ 零 AI 调用、零提取，规格整体沿用
    adapter.getChangeContext.mockResolvedValue({
      message: "docs: clarify pipeline contract\n\nbody",
      committedAt: "2026-11-01T00:00:00Z",
      url: "https://github.com/commit/docs",
      files: [{ path: "docs/analysis-pipeline.md", status: "modified", patch: "+文档内容不是行为。" }],
    });
    await runAnalysis(8);
    expect(analyzeWithAI).not.toHaveBeenCalled();
    expect(partitionedSourcesMock).not.toHaveBeenCalled();
    expect(vi.mocked(insertSpecVersion)).toHaveBeenCalled();
    const calledResult = vi.mocked(insertSpecVersion).mock.calls[0][2];
    expect(calledResult.features[0]?.name).toBe("统一登录");
    expect(calledResult.changes).toEqual([]);
    // 结算照常（run 消耗了调度与账务链路；SAU 口径为产品决策）
    expect(vi.mocked(capture)).toHaveBeenCalled();
  });

  it("records a readable failure when loading the run fails", async () => {
    loadError = new Error("load failed");
    await runAnalysis(8);
    const [stored] = execute.mock.calls.find(([sql]) => String(sql).includes("status = 'failed'"))?.[1] as unknown[];
    expect(String(stored).startsWith("load failed\n")).toBe(true);
    // 失败释放（契约 §6.6）：置 failed 后独立调用 release，失败由 sweep 兜底
    expect(vi.mocked(release)).toHaveBeenCalledWith(8, "analysis_failed");
  });

  it("re-queues a run whose entry reservation is billing-gated instead of failing it (contract §6.6)", async () => {
    runRows = [{ ...run, accountId: 7 }];
    vi.mocked(hasActiveReservation).mockResolvedValueOnce(false);
    vi.mocked(reserveForNewRun).mockRejectedValueOnce(new BillingError("quota_exceeded", "available 0 SAU is below requested 1 SAU"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runAnalysis(8);
      // 账务拒绝不是终态：保持 queued 等额度/订阅恢复后由 sweep 补跑，不标 failed、不释放
      expect(execute).toHaveBeenCalledWith(
        "UPDATE analysis_runs SET status = 'queued', started_at = NULL, finished_at = NULL WHERE id = ? AND status = 'running'",
        [8],
      );
      expect(execute).not.toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
      expect(vi.mocked(release)).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("records a fallback failure for non-Error rejections", async () => {
    loadError = "denied";
    await runAnalysis(8);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), ["Unknown analysis error", 8]);
  });
});
