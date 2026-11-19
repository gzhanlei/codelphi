import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BehaviorManifest, BehaviorUnit } from "../lib/behavior-inventory/types";
import { manifestHash } from "../lib/behavior-inventory/manifest";
import { BehaviorBudgetError, UNLIMITED_MAX_COST_AMOUNT, UNLIMITED_MAX_LLM_CALLS, UNLIMITED_MAX_TOTAL_TOKENS } from "../lib/behavior-run-budget";
import { InventoryPersistenceError } from "../lib/behavior-unit-receipts";
import { extractBehaviorTask } from "../lib/behavior-unit-extraction";
import { claimBehaviorTask, commitBehaviorTaskResult, insertManifestIfAbsent, loadVerifiedManifest, markBehaviorTaskFailure } from "../lib/behavior-unit-receipts";
import { releaseUnusedBehaviorBudget, reserveBehaviorBudget, reserveProductSummaryBudget, settleBehaviorBudget } from "../lib/behavior-run-budget";
import { runAnalysis } from "../lib/analysis";
import { analyzeBehavioralGroup, analyzeWithAI } from "../lib/ai";
import { getPartitionedAnalysisSources } from "../lib/remote-analysis";
import { insertSpecVersion } from "../lib/spec-versions";
import { behaviorAnalysisBudget, behaviorAnalysisConcurrency, fullAnalysisMode } from "../lib/env";
import { runInventoryFullAnalysis } from "../lib/full-analysis";
import type { InventoryFullAnalysisOutcome } from "../lib/full-analysis";
import type { BehaviorTaskExtractionResult } from "../lib/behavior-unit-extraction";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";

/** Task 13 契约（2026-11-19 行为清单全量分析）：全量编排三模式。
 *  - fullAnalysisMode 默认 legacy；legacy 完全走旧分区/收敛；
 *  - inventory_shadow 旧结果唯一激活，新路径 best-effort 且 LLM 计费 platform_shadow；
 *  - inventory 只替代 affectedKeys===null 的全量提取（增量/RC2-carry 不进入新编排）；
 *  - 首跑扫描并插入不可变 manifest；恢复 loadVerifiedManifest、复用成功 result_json、只领取可领取任务；
 *  - 调度固定 reserve → claim；claim 失败立即释放预留；预算不足不得领取租约；
 *  - 单元失败/未决或任一激活门禁失败 → 不调用 saveResult，旧激活规格不变。
 *  测试不接外部 AI：extractBehaviorTask 与摘要通道全部注入替身。 */

const actualFullAnalysis = await vi.importActual<typeof import("../lib/full-analysis")>("../lib/full-analysis");

// ---------- 共享夹具：tiny repo（两个实现文件） ----------
const FILES: Record<string, string[]> = {
  "src/orders.ts": [
    'import { db } from "./db";',
    "export function listOrders(userId: string) {",
    "  return db.orders.filter((order) => order.userId === userId);",
    "}",
    "export function closeOrder(orderId: string) {",
    '  return db.orders.update(orderId, { status: "closed" });',
    "}",
  ],
  "src/util.ts": ["export function formatMoney(cents: number) {", "  return `¥${(cents / 100).toFixed(2)}`;", "}"],
};
const FILE_CONTENT = Object.fromEntries(Object.entries(FILES).map(([path, lines]) => [path, lines.join("\n")]));

const RUN_ID = 8;

interface FakeTaskRow {
  taskKey: string;
  unitKey: string;
  status: string;
  attempts: number;
  resultJson: string | null;
  attemptId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: number;
}

const store = {
  manifest: null as BehaviorManifest | null,
  manifestTampered: false,
  manifestVersionConflict: false,
  tasks: new Map<string, FakeTaskRow>(),
  linkInserts: [] as unknown[][],
  budgetRow: null as unknown[] | null,
};

const budget = {
  seq: 0,
  reserveCalls: 0,
  failReservesAfter: Number.POSITIVE_INFINITY,
  usageUnknownFor: new Set<string>(),
  reservations: new Map<string, { reservationId: string; attemptId: string }>(),
  settled: [] as string[],
  released: [] as string[],
};

const zeroSanitize = (empty: boolean) => ({ droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty, keptClaims: 0 });

function extractedResult(task: BehaviorExecutionTask, primaryPath: string): BehaviorTaskExtractionResult {
  // 每个单元的行为内容必须可区分（真实仓库里不同函数即不同行为）——全部相同会被合并层
  // 按行为等价去重/变体折叠（mergeStats 失真的夹具 bug，不是实现契约）。情境带首个分片
  // 起始行；操作/结果带单元身份段（unitKey 三元组第二段），否则合并层按规则 4「操作+结果
  // 等价即同行为」把跨文件单元折叠成一个功能。
  const marker = task.anchorFragments[0]?.ranges[0]?.startLine ?? 0;
  const unitSegment = (() => {
    try {
      const parsed = JSON.parse(task.unitKey.split("|").slice(2).join("|")) as unknown[];
      return String(parsed[1] ?? task.unitKey);
    } catch {
      return task.unitKey;
    }
  })();
  return {
    outcome: "extracted",
    features: [
      {
        name: `功能 ${primaryPath}`,
        summary: `摘要 ${primaryPath}`,
        scenarios: [
          { reference: "HP-1", context: `情境 ${primaryPath}#${marker}`, action: `调用 ${unitSegment}`, outcome: `返回 ${unitSegment} 结果`, category: "happy", evidence: [{ path: primaryPath, startLine: 1 }] },
        ],
      },
    ],
    anchorReceipts: task.anchorFragments.map((fragment) => ({
      anchorKey: fragment.anchorKey,
      anchorFragmentKey: fragment.anchorFragmentKey,
      disposition: "extracted" as const,
      evidence: [{ path: primaryPath, startLine: 1 }],
      scenarioRefs: ["HP-1"],
    })),
    scenarioCount: 1,
    reviewedCount: 0,
    unresolvedAnchorCount: 0,
    sanitize: { ...zeroSanitize(false), keptClaims: 1 },
  };
}

function unresolvedResult(task: BehaviorExecutionTask): BehaviorTaskExtractionResult {
  return {
    outcome: "unresolved",
    features: [],
    anchorReceipts: task.anchorFragments.map((fragment) => ({
      anchorKey: fragment.anchorKey,
      anchorFragmentKey: fragment.anchorFragmentKey,
      disposition: "unresolved" as const,
      reason: "model_unresolved",
      evidence: [],
      scenarioRefs: [],
    })),
    scenarioCount: 0,
    reviewedCount: 0,
    unresolvedAnchorCount: task.anchorFragments.length,
    sanitize: zeroSanitize(true),
  };
}

const index = {
  scopeRoots: [] as Array<{ path: string; role: string }>,
  listRoot: vi.fn(async () => ({ status: "indexed", truncated: false, entries: [{ path: "src", type: "tree" }] })),
  listDir: vi.fn(async (path: string) => ({
    status: "indexed",
    truncated: false,
    entries: Object.keys(FILES)
      .filter((file) => file.startsWith(`${path}/`))
      .map((file) => ({ path: file, type: "blob", size: FILE_CONTENT[file].length })),
  })),
  statPath: vi.fn(async (path: string) => (FILE_CONTENT[path] ? { path, byteSize: FILE_CONTENT[path].length } : null)),
  readLines: vi.fn(async (request: { path: string; startLine: number; endLine: number }) => {
    const lines = FILES[request.path];
    if (!lines) throw new Error(`missing ${request.path}`);
    const slice = lines.slice(request.startLine - 1, request.endLine);
    return { path: request.path, startLine: request.startLine, endLine: request.startLine + slice.length - 1, lines: slice, byteSize: 0, lineCount: lines.length };
  }),
};

const execute = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql.includes("FROM analysis_behavior_manifests")) return [store.manifest ? [{ run_id: RUN_ID }] : []];
  if (sql.includes("INSERT IGNORE INTO analysis_behavior_tasks")) {
    const [runId, taskKey, , unitKey] = params as [number, string, string, string];
    void runId;
    if (!store.tasks.has(taskKey)) {
      store.tasks.set(taskKey, { taskKey, unitKey, status: "pending", attempts: 0, resultJson: null, attemptId: null, leaseOwner: null, leaseExpiresAt: 0 });
    }
    return [{}];
  }
  if (sql.includes("INSERT IGNORE INTO analysis_run_budgets")) {
    store.budgetRow = params as unknown[];
    return [{}];
  }
  if (sql.includes("INSERT IGNORE INTO analysis_behavior_anchor_scenarios")) {
    store.linkInserts.push(params as unknown[]);
    return [{}];
  }
  if (sql.includes("FROM analysis_behavior_tasks")) {
    return [[...store.tasks.values()].map((row) => ({ task_key: row.taskKey, status: row.status, attempts: row.attempts, result_json: row.resultJson }))];
  }
  if (sql.includes("FROM products")) return [[]];
  return [{}];
});

// ---------- 幂等 fake 实现（模块级函数：vi.mock 工厂与 beforeEach 复位共用，杜绝跨测试实现泄漏） ----------
function mockInsertManifestIfAbsentImpl(_execute: unknown, _runId: number, manifest: BehaviorManifest) {
  if (store.manifest) {
    if (manifestHash(store.manifest) === manifestHash(manifest)) return Promise.resolve();
    return Promise.reject(new InventoryPersistenceError("inventory_version_conflict", "run already has a different manifest"));
  }
  store.manifest = manifest;
  return Promise.resolve();
}

function mockLoadVerifiedManifestImpl() {
  if (!store.manifest || store.manifestTampered) {
    return Promise.reject(new InventoryPersistenceError("inventory_manifest_tampered", "persisted manifest is unverifiable"));
  }
  if (store.manifestVersionConflict) {
    return Promise.reject(new InventoryPersistenceError("inventory_version_conflict", "manifest written by another inventory version"));
  }
  return Promise.resolve(store.manifest);
}

function mockClaimBehaviorTaskImpl(input: { runId: number; taskKey: string; leaseOwner: string; leaseDurationMs: number; maxAttempts: number }) {
  const row = store.tasks.get(input.taskKey);
  if (!row) return Promise.resolve(null);
  const now = Date.now();
  const eligible =
    row.status === "pending" ||
    ((row.status === "failed" || row.status === "unresolved") && row.attempts < input.maxAttempts) ||
    (row.status === "running" && row.leaseExpiresAt > 0 && row.leaseExpiresAt <= now);
  if (!eligible) return Promise.resolve(null);
  row.status = "running";
  row.attempts += 1;
  row.attemptId = `attempt-${row.attempts}-${input.taskKey.length}`;
  row.leaseOwner = input.leaseOwner;
  row.leaseExpiresAt = now + input.leaseDurationMs;
  return Promise.resolve({
    runId: input.runId,
    taskKey: input.taskKey,
    unitKey: row.unitKey,
    kind: "file",
    primaryPath: "src/orders.ts",
    primaryRanges: null,
    contextRanges: [],
    anchorFragments: [],
    detector: "residual",
    detectorVersion: "1",
    attemptId: row.attemptId,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: new Date(row.leaseExpiresAt),
    attempts: row.attempts,
  });
}

function mockCommitBehaviorTaskResultImpl(input: { runId: number; taskKey: string; attemptId: string; leaseOwner: string; outcome: string; result: unknown }) {
  const row = store.tasks.get(input.taskKey);
  if (!row || row.status !== "running" || row.attemptId !== input.attemptId || row.leaseOwner !== input.leaseOwner) return Promise.resolve(false);
  row.status = input.outcome;
  row.resultJson = JSON.stringify(input.result);
  return Promise.resolve(true);
}

function mockMarkBehaviorTaskFailureImpl(input: { runId: number; taskKey: string; attemptId: string; leaseOwner: string; abortedBeforeExecution?: boolean }) {
  const row = store.tasks.get(input.taskKey);
  if (!row || row.status !== "running" || row.attemptId !== input.attemptId || row.leaseOwner !== input.leaseOwner) return Promise.resolve();
  if (input.abortedBeforeExecution === true) {
    row.status = "pending";
    row.attemptId = null;
    row.leaseOwner = null;
    row.leaseExpiresAt = 0;
  } else {
    row.status = "failed";
  }
  return Promise.resolve();
}

function mockReserveBehaviorBudgetImpl(input: { runId: number; attemptId: string; maxLlmCalls: number; maxInputTokens: number; maxOutputTokens: number; maxCostAmount: number }) {
  budget.reserveCalls += 1;
  if (budget.reserveCalls > budget.failReservesAfter) {
    return Promise.reject(new BehaviorBudgetError("behavior_budget_exceeded", "budget exhausted"));
  }
  const reservationId = `res-${budget.seq += 1}`;
  budget.reservations.set(reservationId, { reservationId, attemptId: input.attemptId });
  return Promise.resolve({
    reservationId,
    runId: input.runId,
    attemptId: input.attemptId,
    kind: "task" as const,
    reservedLlmCalls: input.maxLlmCalls,
    reservedInputTokens: input.maxInputTokens,
    reservedOutputTokens: input.maxOutputTokens,
    reservedCostAmount: input.maxCostAmount,
  });
}

function mockReserveProductSummaryBudgetImpl(runId: number) {
  return Promise.resolve({
    reservationId: "summary-res",
    runId,
    attemptId: "product_summary",
    kind: "product_summary" as const,
    reservedLlmCalls: 1,
    reservedInputTokens: 128_000,
    reservedOutputTokens: 8_192,
    reservedCostAmount: 5,
  });
}

function mockSettleBehaviorBudgetImpl(input: { reservationId: string }) {
  if (budget.usageUnknownFor.has(input.reservationId)) {
    return Promise.reject(new BehaviorBudgetError("behavior_budget_usage_unknown", "usage unknown under configured cap"));
  }
  budget.settled.push(input.reservationId);
  return Promise.resolve();
}

function mockReleaseUnusedBehaviorBudgetImpl(reservationId: string) {
  budget.released.push(reservationId);
  return Promise.resolve();
}

vi.mock("../lib/behavior-unit-receipts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/behavior-unit-receipts")>();
  return {
    ...actual,
    insertManifestIfAbsent: vi.fn(mockInsertManifestIfAbsentImpl),
    loadVerifiedManifest: vi.fn(mockLoadVerifiedManifestImpl),
    claimBehaviorTask: vi.fn(mockClaimBehaviorTaskImpl),
    commitBehaviorTaskResult: vi.fn(mockCommitBehaviorTaskResultImpl),
    markBehaviorTaskFailure: vi.fn(mockMarkBehaviorTaskFailureImpl),
  };
});

vi.mock("../lib/behavior-run-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/behavior-run-budget")>();
  return {
    ...actual,
    reserveBehaviorBudget: vi.fn(mockReserveBehaviorBudgetImpl),
    reserveProductSummaryBudget: vi.fn(mockReserveProductSummaryBudgetImpl),
    settleBehaviorBudget: vi.fn(mockSettleBehaviorBudgetImpl),
    releaseUnusedBehaviorBudget: vi.fn(mockReleaseUnusedBehaviorBudgetImpl),
  };
});

vi.mock("../lib/behavior-unit-extraction", () => ({ extractBehaviorTask: vi.fn() }));

// ---------- 路由测试用的 analysis 线束（与 tests/analysis-run.test.ts 同形） ----------
const routeExecute = vi.fn();
const routeConnection = {
  execute: vi.fn(),
  beginTransaction: vi.fn(async () => undefined),
  commit: vi.fn(async () => undefined),
  rollback: vi.fn(async () => undefined),
  release: vi.fn(),
};
const routeAdapter = {
  provider: "github" as const,
  getRepository: vi.fn(),
  getChangeContext: vi.fn(),
};
const routeRun = {
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
const routeState = { runRows: [routeRun] as unknown[], sourceRows: [] as unknown[] };

vi.mock("../lib/db", () => ({ getDb: () => ({ execute: routeExecute, getConnection: async () => routeConnection }) }));
vi.mock("../lib/billing/core", () => ({
  BillingError: class BillingError extends Error {
    constructor(public code: string, message: string) {
      super(`[${code}] ${message}`);
    }
  },
  enqueueRunWithReservation: vi.fn(async () => ({ runId: 55, attempt: 1, allocations: [], reused: false, requestId: "req" })),
  hasActiveReservation: vi.fn(async () => true),
  heartbeat: vi.fn(async () => ({ renewed: true })),
  capture: vi.fn(async () => ({ runSettlementStatus: "fully_settled" })),
  release: vi.fn(async () => ({ released: true })),
  reserveForNewRun: vi.fn(async () => ({ attempt: 1, allocations: [], reused: false })),
}));
vi.mock("../lib/code-hosting", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/code-hosting")>(),
  resolveAnalysisTarget: vi.fn((run: typeof routeRun) => ({
    adapter: routeAdapter,
    access: { connectionId: run.connectionId, organizationId: run.organizationId },
    product: { id: run.productId, slug: run.productSlug, name: run.productName },
  })),
}));
vi.mock("../lib/ai", () => ({
  analyzeWithAI: vi.fn(),
  analyzeBehavioralGroup: vi.fn(),
  requestStructuredCompletion: vi.fn(),
  systemPrompt: vi.fn(() => "system prompt"),
  AiOutputTruncatedError: class AiOutputTruncatedError extends Error {
    static isInstance(_e: unknown) {
      return false;
    }
  },
}));
vi.mock("../lib/notifications", () => ({ deliverAnalysisNotifications: vi.fn(async () => undefined) }));
vi.mock("../lib/release-change-projection", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/release-change-projection")>(),
  rewriteReleaseChangeProjections: vi.fn(async () => ({ rewritten: 0, failed: 0 })),
}));
vi.mock("../lib/incremental-shadow", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/incremental-shadow")>(),
  compareIncrementalShadow: vi.fn(() => ({ consistent: true, missingKeys: [], extraKeys: [], scenarioDiffs: [] })),
}));
const { partitionedSourcesMock } = vi.hoisted(() => ({ partitionedSourcesMock: vi.fn() }));
vi.mock("../lib/remote-analysis", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/remote-analysis")>(),
  getRemoteAnalysisSources: vi.fn(),
  getPartitionedAnalysisSources: partitionedSourcesMock,
}));
vi.mock("../lib/spec-versions", () => ({
  loadLatestSpecVersionLanguage: vi.fn(async () => null),
  insertSpecVersion: vi.fn(async () => ({
    specVersionId: 44,
    specChanges: [],
    features: [{ name: "统一登录", summary: "s", scenarios: [] }],
    collapse: null,
    featureCollapses: [],
    misplacedScenarios: [],
    identityHijacksDropped: 0,
    featureFolds: [],
    scenarioIdByLocalKey: new Map(),
  })),
  loadLatestSpecFeatures: vi.fn(async () => ({ specVersionId: 44, features: [{ name: "统一登录", summary: "s", scenarios: [] }] })),
  loadPreviousFeatureNames: vi.fn(async () => ["统一登录", "支付", "规格导出"]),
  loadPreviousSpecText: vi.fn(async () => [{ name: "统一登录", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy" }] }]),
}));
vi.mock("../lib/architecture-version", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/architecture-version")>(),
  generateRepositoryArchitectureVersion: vi.fn(async () => ({ status: "accepted", errorMessage: null })),
}));
vi.mock("../lib/feature-flow-service", () => ({ syncFeatureFlowsForVersion: vi.fn(async () => ({ generated: 0, copied: 0, failed: 0 })), regenerateFeatureFlowForWorkbenchFeature: vi.fn() }));
vi.mock("../lib/full-analysis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/full-analysis")>();
  return { ...actual, runInventoryFullAnalysis: vi.fn(actual.runInventoryFullAnalysis) };
});

const shadowedReadLines = vi.fn();
const routeIndex = { readLines: shadowedReadLines, listDir: vi.fn(), listRoot: vi.fn(), statPath: vi.fn() };

function resetRouteHarness() {
  routeState.runRows = [routeRun];
  routeState.sourceRows = [];
  routeExecute.mockImplementation(async (sql: string) => {
    if (sql.includes("SET status = 'running'")) return [{ affectedRows: 1 }];
    if (sql.includes("SET status = 'failed'")) return [{ affectedRows: 1 }];
    if (sql.includes("JOIN repositories repo")) return [routeState.runRows];
    if (sql.includes("source_roots")) return [routeState.sourceRows];
    return [{}];
  });
  routeConnection.execute.mockImplementation(async (sql: string) => {
    if (sql.includes("SET status = 'running'")) return [{ affectedRows: 1 }];
    if (sql.includes("SET status = 'failed'")) return [{ affectedRows: 1 }];
    if (sql.includes("SELECT id FROM analysis_runs WHERE repository_id = ?")) return [[{ id: 8 }]];
    if (sql.includes("SET status = 'succeeded'")) return [{ affectedRows: 1 }];
    if (sql.includes("analysis_run_id AS analysisRunId")) return [[{ id: 6, analysisRunId: 8 }]];
    if (sql.includes("SELECT id FROM releases")) return [[{ id: 6 }]];
    if (sql.includes("SELECT COUNT")) return [[{ count: 1 }]];
    if (sql.includes("UPDATE analysis_behavior_anchor_scenarios SET final_scenario_id")) return [{ affectedRows: 1 }];
    // 同事务真实模块（rebuildSpecFileIndex / markSpecDrift）的 SELECT：空行集，绝不返回 [{}] 伪造行
    if (sql.includes("FROM spec_features sf")) return [[]];
    if (sql.includes("FROM spec_changes")) return [[]];
    return [{}];
  });
  routeAdapter.getRepository.mockResolvedValue({ owner: "gzhanlei", name: "radar", defaultBranch: "main" });
  routeAdapter.getChangeContext.mockResolvedValue({ message: "change", committedAt: "2026-11-01T00:00:00Z", url: "https://github.com/commit/sha", files: [{ path: "lib/auth.ts", status: "modified", patch: "+export const ok = 1;" }] });
  partitionedSourcesMock.mockResolvedValue({
    partitions: [{ slice: { files: [{ path: "lib/db.ts" }] }, sources: [] }],
    index: routeIndex,
  });
  // 覆盖回执的全树实现面枚举依赖 listRoot/listDir；增量定向枚举依赖 statPath（与 analysis-run.test.ts 同形）
  routeIndex.listRoot.mockResolvedValue({ status: "indexed", truncated: false, entries: [{ path: "lib", type: "tree" }] });
  routeIndex.listDir.mockResolvedValue({ status: "indexed", truncated: false, entries: [{ path: "lib/db.ts", type: "blob", size: 100 }] });
  routeIndex.statPath.mockImplementation(async (path: string) => ({ path, byteSize: 100 }));
  shadowedReadLines.mockImplementation(async (request: { path: string }) => ({ startLine: 1, endLine: 1, lineCount: 1, byteSize: 100, lines: [`${request.path} evidence`] }));
  vi.mocked(analyzeWithAI).mockResolvedValue({
    product: { description: "代码驱动的产品知识与变更中心。", evidence: [{ path: "lib/db.ts", startLine: 1 }] },
    release: { title: "v1", summary: "summary" },
    features: [],
    changes: [],
  });
  // 行为面枚举默认开启（BEHAVIORAL_ENUMERATION 未设）：组提取替身返回空结果，不进入 AI
  vi.mocked(analyzeBehavioralGroup).mockResolvedValue({
    product: { description: "", evidence: [] },
    release: { title: "", summary: "" },
    features: [],
    changes: [],
  } as never);
}

function inventoryOutcome(overrides: Partial<InventoryFullAnalysisOutcome> = {}): InventoryFullAnalysisOutcome {
  const localKey = 'scenario|["unit|x","anchor|a","001"]';
  return {
    activated: true,
    result: {
      product: { description: "库存编排产出的产品简介。", evidence: [{ path: "src/orders.ts", startLine: 1 }] },
      release: { title: "inventory", summary: "行为清单全量重建" },
      changes: [],
      features: [
        {
          name: "统一登录",
          summary: "s",
          scenarios: [
            { reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "src/orders.ts", startLine: 1 }], originKeys: [localKey] },
          ],
        },
      ],
    },
    coverage: { implFilesAssembled: 2, implFilesTotal: 2, implBytesAssembled: 100, implBytesTotal: 100, coverageRatio: 1, partitionsUsed: 1, partitionsCapped: false, diffTotalPaths: 1, diffSelectedPaths: 1, diffOmittedPaths: 0 },
    enumerationMetrics: { pathsTotal: 0, pathsEnumerated: 0, pathsOmitted: 0, hunksTotal: 0, hunksTruncated: 0, groupsTotal: 0, groupsCompleted: 0, groupsFailed: 0, status: "not_applicable" },
    passInfos: [{ retries: 0, sanitize: { droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty: false, keptClaims: 1 } }],
    mergeStats: { changesTruncated: 0, scenariosDeduped: 0, featuresFolded: 0 },
    behaviorLinks: [{ runId: 8, unitKey: "unit|x", anchorKey: "anchor|a", localScenarioKey: localKey }],
    gate: {
      activate: true,
      checks: {
        inventoryManifestValid: true,
        primaryCoverageComplete: true,
        anchorCoverageComplete: true,
        anchorAccountingComplete: true,
        allUnitsInAllowedTerminalStates: true,
        existingEvidenceChecksPassed: true,
        existingMergeChecksPassed: true,
      },
      unaccountedAnchorKeys: [],
    },
    unitStatuses: [{ unitKey: "unit|x", status: "extracted" }],
    productDescriptionStatus: "generated",
    tasks: { total: 1, reusedTerminal: 0, executed: 1, pending: 0 },
    ...overrides,
  };
}

// ---------- Part 1：env readers ----------
describe("full-analysis env readers", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("fullAnalysisMode defaults to legacy and parses the two inventory modes", () => {
    expect(fullAnalysisMode()).toBe("legacy");
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory");
    expect(fullAnalysisMode()).toBe("inventory");
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory_shadow");
    expect(fullAnalysisMode()).toBe("inventory_shadow");
  });

  it("fullAnalysisMode falls back to legacy on garbage input", () => {
    vi.stubEnv("FULL_ANALYSIS_MODE", "enable-the-new-thing");
    expect(fullAnalysisMode()).toBe("legacy");
    vi.stubEnv("FULL_ANALYSIS_MODE", "");
    expect(fullAnalysisMode()).toBe("legacy");
  });

  it("behaviorAnalysisConcurrency defaults to 4 and clamps to [1, 16]", () => {
    expect(behaviorAnalysisConcurrency()).toBe(4);
    vi.stubEnv("ANALYSIS_BEHAVIOR_CONCURRENCY", "8");
    expect(behaviorAnalysisConcurrency()).toBe(8);
    vi.stubEnv("ANALYSIS_BEHAVIOR_CONCURRENCY", "0");
    expect(behaviorAnalysisConcurrency()).toBe(4);
    vi.stubEnv("ANALYSIS_BEHAVIOR_CONCURRENCY", "abc");
    expect(behaviorAnalysisConcurrency()).toBe(4);
    vi.stubEnv("ANALYSIS_BEHAVIOR_CONCURRENCY", "99");
    expect(behaviorAnalysisConcurrency()).toBe(16);
  });

  it("behaviorAnalysisBudget uses undefined for no cap, never 0", () => {
    const uncapped = behaviorAnalysisBudget();
    expect(uncapped.maxLlmCalls).toBeUndefined();
    expect(uncapped.maxTotalTokens).toBeUndefined();
    expect(uncapped.maxCostAmount).toBeUndefined();
    expect(uncapped.maxLlmCalls).not.toBe(0);
    expect(uncapped.currency).toBe("CNY");
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_LLM_CALLS", "0");
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_TOTAL_TOKENS", "-5");
    expect(behaviorAnalysisBudget().maxLlmCalls).toBeUndefined();
    expect(behaviorAnalysisBudget().maxTotalTokens).toBeUndefined();
  });

  it("behaviorAnalysisBudget reads the four named env vars", () => {
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_LLM_CALLS", "200");
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_TOTAL_TOKENS", "1000000");
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_COST_AMOUNT", "12.5");
    vi.stubEnv("ANALYSIS_BEHAVIOR_COST_CURRENCY", "USD");
    expect(behaviorAnalysisBudget()).toEqual({ maxLlmCalls: 200, maxTotalTokens: 1_000_000, maxCostAmount: 12.5, currency: "USD" });
  });
});

// ---------- Part 2：runInventoryFullAnalysis 编排（真实实现 + 叶子替身） ----------
describe("runInventoryFullAnalysis orchestration", () => {
  const runContext = {
    id: RUN_ID,
    repositoryId: 3,
    productId: 4,
    owner: "gzhanlei",
    name: "radar",
    beforeSha: null,
    afterSha: "c0e1d0235f033005238dc07a6bcae8a02ed171f8",
    connectionId: 42,
    provider: "github" as const,
    organizationId: 7,
    productSlug: "radar",
    productName: "CoDelphi",
  };
  const change = { message: "feat: orders", committedAt: "2026-11-01T00:00:00Z", url: "https://github.com/commit/sha", files: [{ path: "src/orders.ts", status: "modified", patch: "+x" }] };
  const requestCompletion = vi.fn(async () => JSON.stringify({ description: "订单与金额工具。", evidence: [{ path: "src/orders.ts", startLine: 1 }] }));

  function baseInput() {
    return {
      run: runContext,
      change,
      repository: { owner: "gzhanlei", repo: "radar", revision: runContext.afterSha },
      access: { connectionId: 42, organizationId: 7 },
      provider: "github" as const,
      scopeRoots: [] as Array<{ path: string; role: "shared" }>,
      knownFeatureNames: ["统一登录"],
      execute: execute as never,
      index: index as never,
      requestCompletion: requestCompletion as never,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // clearAllMocks 不复位实现：任何测试覆盖过的实现必须逐测试重建，杜绝跨测试泄漏
    // （mockResolvedValue(null) 曾泄漏到后续全部测试，claim 恒 null → 门禁失败/挂起）。
    vi.mocked(insertManifestIfAbsent).mockImplementation(mockInsertManifestIfAbsentImpl);
    vi.mocked(loadVerifiedManifest).mockImplementation(mockLoadVerifiedManifestImpl);
    vi.mocked(claimBehaviorTask).mockImplementation(mockClaimBehaviorTaskImpl);
    vi.mocked(commitBehaviorTaskResult).mockImplementation(mockCommitBehaviorTaskResultImpl);
    vi.mocked(markBehaviorTaskFailure).mockImplementation(mockMarkBehaviorTaskFailureImpl);
    vi.mocked(reserveBehaviorBudget).mockImplementation(mockReserveBehaviorBudgetImpl);
    vi.mocked(reserveProductSummaryBudget).mockImplementation(mockReserveProductSummaryBudgetImpl);
    vi.mocked(settleBehaviorBudget).mockImplementation(mockSettleBehaviorBudgetImpl);
    vi.mocked(releaseUnusedBehaviorBudget).mockImplementation(mockReleaseUnusedBehaviorBudgetImpl);
    store.manifest = null;
    store.manifestTampered = false;
    store.manifestVersionConflict = false;
    store.tasks = new Map();
    store.linkInserts = [];
    store.budgetRow = null;
    budget.seq = 0;
    budget.reserveCalls = 0;
    budget.failReservesAfter = Number.POSITIVE_INFINITY;
    budget.usageUnknownFor = new Set();
    budget.reservations = new Map();
    budget.settled = [];
    budget.released = [];
    vi.mocked(extractBehaviorTask).mockImplementation(async (input: { task: BehaviorExecutionTask; sources: Array<{ path: string; role: string }> }) => {
      const primary = input.sources.find((source) => source.role === "primary") ?? input.sources[0];
      return extractedResult(input.task, primary.path);
    });
  });

  it("first run scans once, inserts an immutable manifest, reserves before claiming and settles each task", async () => {
    const outcome = await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });

    // 首跑扫描：实现面枚举 + 逐文件内容读取；manifest 只插入一次
    expect(index.listRoot).toHaveBeenCalled();
    expect(index.listDir).toHaveBeenCalled();
    expect(index.readLines).toHaveBeenCalled();
    expect(vi.mocked(insertManifestIfAbsent)).toHaveBeenCalledTimes(1);
    expect(store.manifest).not.toBeNull();
    const manifest = store.manifest as BehaviorManifest;
    expect(manifest.units.length).toBeGreaterThan(0);
    expect(manifest.tasks.length).toBeGreaterThan(0);

    // 预算行：未配置上限时写 sentinel（绝不用 0 表示无上限）
    expect(store.budgetRow).not.toBeNull();
    expect(store.budgetRow).toEqual([RUN_ID, UNLIMITED_MAX_LLM_CALLS, UNLIMITED_MAX_TOTAL_TOKENS, UNLIMITED_MAX_COST_AMOUNT, "CNY"]);

    // 摘要预留先于任何任务预留（不与单元抢占）
    expect(vi.mocked(reserveProductSummaryBudget)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reserveProductSummaryBudget).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(reserveBehaviorBudget).mock.invocationCallOrder[0]);

    // 调度固定 reserve → claim；claim 成功绝不释放预留，终态恰好 settle 一次
    expect(vi.mocked(reserveBehaviorBudget).mock.calls.length).toBe(manifest.tasks.length);
    expect(vi.mocked(claimBehaviorTask).mock.calls.length).toBe(manifest.tasks.length);
    for (const [indexOfCall] of vi.mocked(claimBehaviorTask).mock.calls.entries()) {
      expect(vi.mocked(reserveBehaviorBudget).mock.invocationCallOrder[indexOfCall]).toBeLessThan(vi.mocked(claimBehaviorTask).mock.invocationCallOrder[indexOfCall]);
    }
    expect(budget.released).toEqual([]);
    // 任务预留各自恰好 settle 一次；摘要预留经 Task 12 共享解析器恰好 settle 一次（绝不泄漏、绝不重复）
    expect(new Set(budget.settled.filter((id) => id !== "summary-res")).size).toBe(manifest.tasks.length);
    expect(budget.settled.filter((id) => id === "summary-res")).toHaveLength(1);
    expect(budget.released).not.toContain("summary-res");
    // 摘要走共享解析器（Task 12）的计费身份：product_summary attempt + callStage + main
    const summaryCall = requestCompletion.mock.calls[0] as unknown as [unknown, { attemptId?: string; callStage?: string; chargeComponent?: string }] | undefined;
    expect(summaryCall?.[1]).toMatchObject({ attemptId: "product_summary", callStage: "product_summary", chargeComponent: "main" });

    // 提取计费身份：main + 任务/单元/预留 attemptId
    for (const call of vi.mocked(extractBehaviorTask).mock.calls) {
      const billing = (call[0] as { billing: { chargeComponent: string; taskKey: string; unitKey: string; attemptId: string } }).billing;
      expect(billing.chargeComponent).toBe("main");
      expect(billing.taskKey).toBeTruthy();
      expect(billing.unitKey).toBeTruthy();
      expect([...budget.reservations.values()].map((reservation) => reservation.attemptId)).toContain(billing.attemptId);
    }

    // 提交终态与 result.outcome 同步（Task 10 钉死）
    for (const row of store.tasks.values()) {
      expect(["extracted", "no_behavior"]).toContain(row.status);
      expect(JSON.parse(row.resultJson as string).outcome).toBe(row.status);
    }

    // 链接行幂等落库（saveResult 回填 final_scenario_id 的前置）
    expect(store.linkInserts.length).toBe(outcome.behaviorLinks.length);
    expect(outcome.behaviorLinks.length).toBeGreaterThan(0);

    // 结果契约：merged result + coverage + enumerationMetrics + passInfos + mergeStats + links
    expect(outcome.activated).toBe(true);
    expect(outcome.gate.activate).toBe(true);
    expect(outcome.result.features.length).toBe(2);
    for (const feature of outcome.result.features) {
      for (const scenario of feature.scenarios) {
        expect(scenario.originKeys?.length).toBeGreaterThan(0);
      }
    }
    expect(outcome.result.product.description).toBe("订单与金额工具。");
    expect(outcome.productDescriptionStatus).toBe("generated");
    expect(outcome.coverage.coverageRatio).toBe(1);
    expect(outcome.coverage.partitionsCapped).toBe(false);
    expect(outcome.enumerationMetrics.status).toBe("not_applicable");
    // Task 14：inventory 枚举详情如实记录（running/coarse/implicit/fallback/lease/budget/summary + 恢复会计）
    const inventory = outcome.enumerationMetrics.inventory!;
    expect(inventory).toBeDefined();
    expect(inventory.unitsTotal).toBe(manifest.units.length);
    expect(inventory.semanticUnits + inventory.residualUnits).toBe(manifest.units.length);
    expect(inventory.anchorsTotal).toBe(manifest.units.reduce((sum, unit) => sum + unit.anchors.length, 0));
    expect(inventory.entryAnchors + inventory.behaviorAnchors + inventory.implicitReviewAnchors).toBe(inventory.anchorsTotal);
    expect(inventory.coarseReviewAnchors).toBeLessThanOrEqual(inventory.implicitReviewAnchors);
    expect(inventory.tasksTotal).toBe(manifest.tasks.length);
    expect(inventory.tasksReusedTerminal).toBe(0);
    expect(inventory.tasksExecuted).toBe(manifest.tasks.length);
    expect(inventory.tasksPending).toBe(0);
    expect(inventory.leasesHeld).toBe(0);
    expect(inventory.attemptsTotal).toBe(manifest.tasks.length);
    expect(inventory.budgetBlocked).toBe(false);
    expect(inventory.productDescriptionStatus).toBe("generated");
    expect(inventory.primaryRangesOmittedLines).toBe(0);
    // 新路径覆盖回执：主覆盖区间遗漏入账（sourceCoverage complete 必须为零，Task 14）
    expect(outcome.coverage.primaryRangesOmitted).toBe(0);
    expect(outcome.passInfos.length).toBe(manifest.tasks.length);
    expect(outcome.mergeStats).toEqual({ changesTruncated: 0, scenariosDeduped: 0, featuresFolded: 0 });
    expect(outcome.unitStatuses.every((unit) => unit.status === "extracted")).toBe(true);
  });

  it("resume loads and verifies the manifest, reuses successful result_json and never rescans", async () => {
    await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    vi.clearAllMocks();

    const second = await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    expect(second.activated).toBe(true);
    expect(vi.mocked(loadVerifiedManifest)).toHaveBeenCalledTimes(1);
    expect(index.listRoot).not.toHaveBeenCalled();
    expect(index.listDir).not.toHaveBeenCalled();
    expect(vi.mocked(extractBehaviorTask)).not.toHaveBeenCalled();
    expect(vi.mocked(claimBehaviorTask)).not.toHaveBeenCalled();
    expect(vi.mocked(reserveBehaviorBudget)).not.toHaveBeenCalled();
    // 恢复产出与首跑同形（同一持久化结果重合并）
    expect(second.result.features.length).toBe(2);
    expect(second.behaviorLinks.length).toBeGreaterThan(0);
    expect(second.tasks.reusedTerminal).toBe(second.tasks.total);
    // Task 14 恢复会计：复用的成功终态任务计入 tasksReusedTerminal，绝不被误报为
    // 本 run 新执行的提取趟（passInfos 只覆盖实际发起提取的任务）。
    expect(second.enumerationMetrics.inventory?.tasksReusedTerminal).toBe(second.tasks.total);
    expect(second.enumerationMetrics.inventory?.tasksExecuted).toBe(0);
    expect(second.passInfos).toEqual([]);
    expect(second.coverage.primaryRangesOmitted).toBe(0);
  });

  it("resume claims only eligible tasks (failed row below maxAttempts is re-executed once)", async () => {
    await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    vi.clearAllMocks();
    const failedTaskKey = [...store.tasks.keys()][0];
    const row = store.tasks.get(failedTaskKey) as FakeTaskRow;
    row.status = "failed";
    row.attempts = 1;
    row.resultJson = null;

    const second = await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    expect(second.activated).toBe(true);
    expect(vi.mocked(claimBehaviorTask).mock.calls.length).toBe(1);
    expect(vi.mocked(claimBehaviorTask).mock.calls[0][0]).toMatchObject({ taskKey: failedTaskKey });
    expect(vi.mocked(extractBehaviorTask).mock.calls.length).toBe(1);
    expect((store.tasks.get(failedTaskKey) as FakeTaskRow).status).toBe("extracted");
  });

  it("refuses to resume from a tampered manifest and never calls the extractor", async () => {
    await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    vi.clearAllMocks();
    store.manifestTampered = true;
    await expect(actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true })).rejects.toThrow(/inventory_manifest_tampered|tampered/i);
    expect(vi.mocked(extractBehaviorTask)).not.toHaveBeenCalled();
    expect(vi.mocked(insertManifestIfAbsent)).not.toHaveBeenCalled();
  });

  it("refuses to resume on a version conflict; regenerating the manifest cannot heal it", async () => {
    await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    vi.clearAllMocks();
    store.manifestVersionConflict = true;
    await expect(actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true })).rejects.toThrow(/inventory_version_conflict|conflict/i);
    expect(vi.mocked(insertManifestIfAbsent)).not.toHaveBeenCalled();
    expect(vi.mocked(extractBehaviorTask)).not.toHaveBeenCalled();
  });

  it("releases the just-acquired reservation immediately when the claim is lost", async () => {
    vi.mocked(claimBehaviorTask).mockResolvedValue(null);
    await expect(actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true })).rejects.toThrow(/gate|incomplete|pending/i);
    const reserves = vi.mocked(reserveBehaviorBudget).mock.calls.length;
    expect(reserves).toBeGreaterThan(0);
    // 每个任务预留都在 claim 失败后立即释放；绝不 settle、绝不调用 LLM；
    // 门禁失败后摘要预留（summary-res）也经安全路径释放（排尾），绝不泄漏
    expect(budget.released.length).toBe(reserves + 1);
    expect(budget.released[reserves]).toBe("summary-res");
    expect(budget.settled).toEqual([]);
    expect(vi.mocked(extractBehaviorTask)).not.toHaveBeenCalled();
    for (const [indexOfCall] of budget.released.slice(0, reserves).entries()) {
      expect(vi.mocked(reserveBehaviorBudget).mock.invocationCallOrder[indexOfCall]).toBeLessThan(vi.mocked(releaseUnusedBehaviorBudget).mock.invocationCallOrder[indexOfCall]);
    }
  });

  it("never claims a lease when the budget cannot cover the reservation and stops dispatching", async () => {
    budget.failReservesAfter = 0;
    await expect(actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true })).rejects.toThrow(/gate|incomplete|pending/i);
    expect(vi.mocked(claimBehaviorTask)).not.toHaveBeenCalled();
    expect(vi.mocked(extractBehaviorTask)).not.toHaveBeenCalled();
    expect(budget.settled).toEqual([]);
  });

  it("marks hard extraction failures failed (not aborted), settles the reservation and retries once", async () => {
    const manifest = await (async () => {
      await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
      return store.manifest as BehaviorManifest;
    })();
    vi.clearAllMocks();
    // clearAllMocks 只清 mock 调用记录：预算台账（普通数组）一并复位，断言只看第二次 run
    budget.seq = 0;
    budget.reserveCalls = 0;
    budget.reservations = new Map();
    budget.settled = [];
    budget.released = [];
    // 复活一个失败任务，第一次提取硬失败、第二次成功
    const failedTask = manifest.tasks[0];
    const row = store.tasks.get(failedTask.taskKey) as FakeTaskRow;
    row.status = "failed";
    row.attempts = 1;
    row.resultJson = null;
    vi.mocked(extractBehaviorTask)
      .mockImplementationOnce(async () => {
        throw new Error("gateway timeout");
      })
      .mockImplementation(async (input: { task: BehaviorExecutionTask; sources: Array<{ path: string; role: string }> }) => {
        const primary = input.sources.find((source) => source.role === "primary") ?? input.sources[0];
        return extractedResult(input.task, primary.path);
      });

    const outcome = await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    expect(outcome.activated).toBe(true);
    const marks = vi.mocked(markBehaviorTaskFailure).mock.calls.map((call) => call[0] as { taskKey: string; abortedBeforeExecution?: boolean });
    expect(marks).toEqual([expect.objectContaining({ taskKey: failedTask.taskKey })]);
    // 硬失败绝不是 abort（不恢复 pending、消耗 attempt 预算）
    expect(marks[0].abortedBeforeExecution).not.toBe(true);
    // 两次 attempt 各自独立预留并各自结算一次；摘要预留经共享解析器恰好结算一次
    expect(vi.mocked(reserveBehaviorBudget).mock.calls.length).toBe(2);
    expect(budget.settled.filter((id) => id !== "summary-res").length).toBe(2);
    expect(budget.settled.filter((id) => id === "summary-res")).toHaveLength(1);
    expect(budget.released).toEqual([]);
  });

  it("fails the run without calling saveResult when a unit stays unresolved", async () => {
    vi.mocked(extractBehaviorTask).mockImplementation(async (input: { task: BehaviorExecutionTask }) => unresolvedResult(input.task));
    await expect(actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true })).rejects.toThrow(/gate|unresolved|incomplete/i);
    // unresolved 是受控终态：已提交（供断点续跑），但激活门禁 fail closed
    for (const row of store.tasks.values()) expect(row.status).toBe("unresolved");
    // 未通过门禁 → 不写锚点关联（saveResult 前置），产品摘要不强行生成
    expect(store.linkInserts).toEqual([]);
  });

  it("aborts before the first LLM call with releaseUnused + pending restore when dispatch stops", async () => {
    // worker1 的 settle 抛 usage_unknown → stopDispatch；worker2 已领取但尚未发起首次 LLM 调用
    // → releaseUnused 全额释放 + abortedBeforeExecution 恢复 pending（不记伪失败、不消耗重试预算）
    const secondClaimGate = vi.fn();
    let allowSecondClaim = false;
    const realClaim = mockClaimBehaviorTaskImpl;
    vi.mocked(claimBehaviorTask).mockImplementation(async (input) => {
      if (vi.mocked(claimBehaviorTask).mock.calls.length === 2) {
        secondClaimGate();
        await new Promise<void>((resolve) => {
          const timer = setInterval(() => {
            if (allowSecondClaim) {
              clearInterval(timer);
              resolve();
            }
          }, 1);
        });
      }
      return realClaim(input) as ReturnType<typeof mockClaimBehaviorTaskImpl>;
    });
    vi.mocked(settleBehaviorBudget).mockImplementation(async () => {
      allowSecondClaim = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new BehaviorBudgetError("behavior_budget_usage_unknown", "usage unknown under configured cap");
    });

    await expect(actualFullAnalysis.runInventoryFullAnalysis({ ...baseInput(), concurrency: 2 }, { activate: true })).rejects.toThrow(/gate|incomplete|pending/i);
    // 被中断的 attempt：预算全额释放、任务恢复 pending，绝不 settle、绝不记 failed
    expect(budget.released.length).toBeGreaterThan(0);
    const aborts = vi.mocked(markBehaviorTaskFailure).mock.calls.map((call) => call[0] as { abortedBeforeExecution?: boolean });
    expect(aborts.some((mark) => mark.abortedBeforeExecution === true)).toBe(true);
    const pendingRows = [...store.tasks.values()].filter((row) => row.status === "pending");
    expect(pendingRows.length).toBeGreaterThan(0);
    // 门禁失败（budgetBlocked）同属摘要前退出：摘要预留经安全路径释放，绝不泄漏
    expect(budget.released).toContain("summary-res");
    expect(budget.settled).not.toContain("summary-res");
  });

  it("releases the pre-reserved summary reservation on gate failure and never settles or leaks it", async () => {
    vi.mocked(extractBehaviorTask).mockImplementation(async (input: { task: BehaviorExecutionTask }) => unresolvedResult(input.task));
    await expect(actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true })).rejects.toThrow(/inventory_activation_gate_failed/);
    // 摘要预留已在派发前取得（D9），门禁失败 = 摘要首次 LLM 调用前的退出：
    // 经 Task 7 修复后的安全路径释放（同事务复位 summary_reserved），绝不 settle、绝不调摘要 LLM
    expect(vi.mocked(reserveProductSummaryBudget)).toHaveBeenCalledTimes(1);
    expect(budget.released).toContain("summary-res");
    expect(budget.settled).not.toContain("summary-res");
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it("releases the summary reservation when dispatch fails fatally before the summary stage", async () => {
    vi.mocked(settleBehaviorBudget).mockImplementation(async (input: { reservationId: string }) => {
      if (input.reservationId === "summary-res") {
        budget.settled.push(input.reservationId);
        return;
      }
      throw new Error("ledger connection reset");
    });
    await expect(actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true })).rejects.toThrow(/ledger connection reset/);
    expect(budget.released).toContain("summary-res");
    expect(budget.settled).not.toContain("summary-res");
    expect(requestCompletion).not.toHaveBeenCalled();
  });

  it("delegates the product summary to the shared Task 12 resolver (no duplicate implementation)", () => {
    const source = readFileSync(path.join(__dirname, "..", "lib", "full-analysis.ts"), "utf8");
    expect(source).toMatch(/import \{[^}]*\bresolveProductDescription\b[^}]*\} from "\.\/behavior-activation"/);
    expect(source).not.toContain("resolveInlineProductSummary");
    expect(source).not.toContain("summaryUserPrompt");
  });

  it("shadow runs use platform_shadow billing, skip the summary reservation and never insert activation links", async () => {
    const outcome = await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: false });
    expect(outcome.activated).toBe(true);
    for (const call of vi.mocked(extractBehaviorTask).mock.calls) {
      const billing = (call[0] as { billing: { chargeComponent: string } }).billing;
      expect(billing.chargeComponent).toBe("platform_shadow");
    }
    expect(vi.mocked(reserveProductSummaryBudget)).not.toHaveBeenCalled();
    expect(store.linkInserts).toEqual([]);
    expect(outcome.productDescriptionStatus).toBe("not_run");
  });

  it("shadow never throws on activation-gate failure (best-effort, old result stays the sole activated output)", async () => {
    vi.mocked(extractBehaviorTask).mockImplementation(async (input: { task: BehaviorExecutionTask }) => unresolvedResult(input.task));
    const outcome = await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: false });
    expect(outcome.activated).toBe(false);
    expect(outcome.gate.activate).toBe(false);
  });

  it("writes configured budget caps into the run budget row", async () => {
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_LLM_CALLS", "500");
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_TOTAL_TOKENS", "2000000");
    vi.stubEnv("ANALYSIS_BEHAVIOR_MAX_COST_AMOUNT", "25.5");
    vi.stubEnv("ANALYSIS_BEHAVIOR_COST_CURRENCY", "USD");
    await actualFullAnalysis.runInventoryFullAnalysis(baseInput(), { activate: true });
    expect(store.budgetRow).toEqual([RUN_ID, 500, 2_000_000, "25.500000", "USD"]);
  });
});

// ---------- Part 3：analysis 主流程的三模式路由 ----------
describe("analysis full-analysis mode routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetRouteHarness();
  });

  it("legacy (default) keeps the old partitioned extraction and never enters the inventory orchestrator", async () => {
    await runAnalysis(8);
    expect(partitionedSourcesMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runInventoryFullAnalysis)).not.toHaveBeenCalled();
    expect(routeConnection.commit).toHaveBeenCalledOnce();
  });

  it("inventory replaces only the full extraction: no partition planning, no old convergence, result activated", async () => {
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory");
    vi.stubEnv("ANALYSIS_CONVERGENCE_ROUNDS", "3");
    const outcome = inventoryOutcome();
    vi.mocked(runInventoryFullAnalysis).mockResolvedValue(outcome);
    vi.mocked(insertSpecVersion).mockResolvedValue({
      specVersionId: 44,
      specChanges: [],
      features: outcome.result.features,
      collapse: null,
      featureCollapses: [],
      misplacedScenarios: [],
      identityHijacksDropped: 0,
      featureFolds: [],
      scenarioIdByLocalKey: new Map([['scenario|["unit|x","anchor|a","001"]', 700]]),
    } as never);

    await runAnalysis(8);

    // 旧分区规划未执行 ⇒ 旧收敛轮同样不执行
    expect(partitionedSourcesMock).not.toHaveBeenCalled();
    expect(vi.mocked(runInventoryFullAnalysis)).toHaveBeenCalledTimes(1);
    const [input, options] = vi.mocked(runInventoryFullAnalysis).mock.calls[0] as unknown as [{ run: { id: number }; knownFeatureNames: string[] }, { activate: boolean }];
    expect(options).toEqual({ activate: true });
    expect(input.run.id).toBe(8);
    expect(input.knownFeatureNames).toEqual(["统一登录", "支付", "规格导出"]);
    // 编排产出激活：规格落库 + 行为链接同事务回填
    expect(routeConnection.commit).toHaveBeenCalledOnce();
    const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    const backfill = routeConnection.execute.mock.calls.find(([sql]) => String(sql).includes("UPDATE analysis_behavior_anchor_scenarios SET final_scenario_id"));
    expect(backfill?.[1]).toEqual([700, 8, sha256("anchor|a"), sha256('scenario|["unit|x","anchor|a","001"]')]);
    expect(routeExecute).not.toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
  });

  it("inventory failure leaves the old active spec untouched (saveResult is never reached)", async () => {
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory");
    vi.mocked(runInventoryFullAnalysis).mockRejectedValue(new Error("inventory_activation_gate_failed:allUnitsInAllowedTerminalStates"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runAnalysis(8);
      expect(partitionedSourcesMock).not.toHaveBeenCalled();
      expect(vi.mocked(insertSpecVersion)).not.toHaveBeenCalled();
      expect(routeConnection.commit).not.toHaveBeenCalled();
      expect(routeExecute).toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
    } finally {
      consoleError.mockRestore();
    }
  });

  it("inventory_shadow keeps the legacy result as the sole activated output and runs the new path best-effort afterwards", async () => {
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory_shadow");
    const outcome = inventoryOutcome({ activated: false, productDescriptionStatus: "not_run" });
    vi.mocked(runInventoryFullAnalysis).mockResolvedValue(outcome);

    await runAnalysis(8);

    // 旧分区/收敛路径完整执行，旧结果是唯一激活产出
    expect(partitionedSourcesMock).toHaveBeenCalledTimes(1);
    expect(routeConnection.commit).toHaveBeenCalledOnce();
    expect(vi.mocked(runInventoryFullAnalysis)).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(runInventoryFullAnalysis).mock.calls[0] as unknown as [unknown, { activate: boolean }];
    expect(options).toEqual({ activate: false });
    // shadow 在旧流程完成（激活事务提交）之后 best-effort 执行
    expect(routeConnection.commit.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(runInventoryFullAnalysis).mock.invocationCallOrder[0]);
    expect(routeExecute).not.toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
  });

  it("inventory_shadow swallows shadow failures; the activated legacy result stands", async () => {
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory_shadow");
    vi.mocked(runInventoryFullAnalysis).mockRejectedValue(new Error("inventory_manifest_tampered"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await runAnalysis(8);
      expect(routeConnection.commit).toHaveBeenCalledOnce();
      expect(routeExecute).not.toHaveBeenCalledWith(expect.stringContaining("status = 'failed'"), expect.anything());
    } finally {
      consoleError.mockRestore();
    }
  });

  it("incremental runs never enter the new full orchestrator, even in inventory mode", async () => {
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory");
    routeState.runRows = [{ ...routeRun, analyzeMode: "incremental" }];
    routeExecute.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status = 'running'")) return [{ affectedRows: 1 }];
      if (sql.includes("SET status = 'failed'")) return [{ affectedRows: 1 }];
      if (sql.includes("JOIN repositories repo")) return [routeState.runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("FROM spec_file_index i")) return [[{ stableKey: "统一登录", name: "统一登录", path: "lib/auth.ts" }]];
      return [{}];
    });

    await runAnalysis(8);

    expect(vi.mocked(runInventoryFullAnalysis)).not.toHaveBeenCalled();
    expect(partitionedSourcesMock).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(insertSpecVersion).mock.calls[0][3] as { affectedKeys?: Set<string> };
    expect(saved.affectedKeys).toEqual(new Set(["统一登录"]));
  });

  it("RC2-carry (affectedKeys resolved from behavioral matches) never enters the new orchestrator", async () => {
    vi.stubEnv("FULL_ANALYSIS_MODE", "inventory");
    routeState.runRows = [{ ...routeRun, analyzeMode: "incremental" }];
    let specFileIndexCalls = 0;
    routeExecute.mockImplementation(async (sql: string) => {
      if (sql.includes("SET status = 'running'")) return [{ affectedRows: 1 }];
      if (sql.includes("SET status = 'failed'")) return [{ affectedRows: 1 }];
      if (sql.includes("JOIN repositories repo")) return [routeState.runRows];
      if (sql.includes("source_roots")) return [[]];
      if (sql.includes("FROM spec_file_index i")) {
        specFileIndexCalls += 1;
        // 第一次（全量回退判定）无命中 → 触发 RC2；第二次（行为变更集）命中 → carry
        return [specFileIndexCalls === 1 ? [] : [{ stableKey: "统一登录", name: "统一登录", path: "lib/auth.ts" }]];
      }
      return [{}];
    });

    await runAnalysis(8);

    expect(vi.mocked(runInventoryFullAnalysis)).not.toHaveBeenCalled();
    expect(partitionedSourcesMock).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(insertSpecVersion).mock.calls[0][3] as { affectedKeys?: Set<string> };
    expect(saved.affectedKeys).toEqual(new Set(["统一登录"]));
  });
});

// 类型级引用（防未使用告警并钉住导出形状）
void InventoryPersistenceError;
void (0 as unknown as BehaviorUnit | null);
