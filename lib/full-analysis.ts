import { createHash, randomUUID } from "node:crypto";
import { type LlmBillingContext } from "./ai";
import type { OutputLanguage } from "./analysis-language";
import type { RunContext } from "./analysis";
import { enumerateImplementationSurface, type AnalysisCoverageReceipt } from "./analysis-coverage";
import type { BehavioralEnumerationMetrics, InventoryEnumerationSummary } from "./behavioral-enumeration";
import { evaluateBehaviorActivationGate, resolveProductDescription, type ActivationGateAnchor, type ActivationGateResult, type ProductDescriptionOutcome } from "./behavior-activation";
import { buildBehaviorInventory, RESIDUAL_DETECTOR_ID } from "./behavior-inventory";
import { evaluateInventoryCoverage } from "./behavior-inventory/coverage";
import { loadBehaviorTaskSources, planBehaviorExecutionTasks, type TaskSource } from "./behavior-inventory/planner";
import type { BehaviorExecutionTask, BehaviorManifest, BehaviorUnit, CodeRange } from "./behavior-inventory/types";
import { mergeBehaviorTaskResults } from "./behavior-result-merge";
import {
  BehaviorBudgetError,
  UNLIMITED_MAX_COST_AMOUNT,
  UNLIMITED_MAX_LLM_CALLS,
  UNLIMITED_MAX_TOTAL_TOKENS,
  releaseUnusedBehaviorBudget,
  reserveBehaviorBudget,
  reserveProductSummaryBudget,
  settleBehaviorBudget,
} from "./behavior-run-budget";
import { extractBehaviorTask, type BehaviorTaskExtractionResult, type StructuredRequest } from "./behavior-unit-extraction";
import {
  InventoryPersistenceError,
  claimBehaviorTask,
  commitBehaviorTaskResult,
  insertManifestIfAbsent,
  loadVerifiedManifest,
  markBehaviorTaskFailure,
} from "./behavior-unit-receipts";
import {
  aggregateBehaviorUnitStatus,
  assignLocalScenarioKeys,
  buildAnchorScenarioLinks,
  type AnchorScenarioLink,
  type BehaviorUnitStatus,
  type LocalScenarioKeyAssignment,
  type UnitTaskState,
} from "./behavior-unit-state";
import { behaviorAnalysisBudget, behaviorAnalysisConcurrency } from "./env";
import { evidenceKind } from "./evidence";
import type { EvidenceSanitizeSummary } from "./completeness-ledger";
import { getDb } from "./db";
import type { ChangeContext, CodeHostingProvider, RepositoryAccess } from "./code-hosting";
import type { Evidence } from "./types";
import type { ExtractionChunk, MergeResult } from "./extraction-merge";
import { analysisSourceIndexBudgets } from "./remote-analysis";
import { createRemoteSourceIndex } from "./remote-source-index";
import type { OpenedRemoteSourceRevision, SourceScopeRoot } from "./remote-source-index/types";
import { loadLatestSpecVersionLanguage } from "./spec-versions";

/**
 * Task 13 · 行为清单全量分析编排（设计 §5.3/§7，D5-D10 收口）：
 *
 * - manifest：首跑扫描（实现面枚举 + 逐文件内容读取）→ buildBehaviorInventory →
 *   排产 → insertManifestIfAbsent（insert-only，冲突即抛，绝不重扫自愈）；
 *   恢复 loadVerifiedManifest（tampered/conflict 直接传播），成功终态复用 result_json。
 *   扫描读失败直接 throw——绝不持久化残缺 manifest；空文件（0 行）无可审行，排除出 sources。
 * - 调度：worker pool，每任务固定 reserve → claim。claim 失败立即 releaseUnused；
 *   reserve 抛 behavior_budget_exceeded → stopDispatch + budgetBlocked，绝不领取租约。
 *   已领取但首次 LLM 调用前 stopDispatch 置位 → releaseUnused + abortedBeforeExecution
 *   恢复 pending（不记伪失败、不消耗重试预算）。每 attempt 恰好 settle 一次；未发生的
 *   attempt（claim 失败 / abort）走 releaseUnused，绝不 settle。
 * - 计费身份：LLM 回执 attemptId = 预留的 attemptId（编排自生成）；claim.attemptId 是
 *   租约身份，只用于 claim/commit/mark 的租约谓词。两个身份各司其职。
 * - 摘要预留：activate 时在任务派发前 reserveProductSummaryBudget（D9：摘要份额不被
 *   单元抢占）；shadow 不预留不生成。摘要生成走 Task 12 共享的 resolveProductDescription
 *   （证据面=合并面，面外剔除；预挂号预留传入后由它恰好 settle 一次，usage 未知硬阻断
 *   透传）。门禁失败/派发致命错误等摘要首次 LLM 调用前的任何退出，编排经 Task 7
 *   fix round 2 的安全路径 releaseUnused 释放该预留（同事务复位 summary_reserved），
 *   绝不泄漏每 run 预算份额。
 * - 门禁：evaluateBehaviorActivationGate fail closed；失败或 budgetBlocked 时 activate
 *   模式 throw（run 失败，saveResult 不可达，旧激活规格不变），shadow 返回 activated:false。
 * - 锚点关联行仅 activate 且过门禁后 INSERT IGNORE 落库（saveResult 回填前置）。
 * - 观测（Task 14）：coverage 回执带主覆盖区间遗漏（新路径 sourceCoverage complete
 *   要求为零）；enumerationMetrics 的 inventory 详情记录单元/锚点状态、coarse/
 *   implicit/fallback 计数、租约与预算、摘要状态与恢复任务会计——恢复复用的成功
 *   任务计入 tasksReusedTerminal，绝不计为本 run 新执行的提取趟。
 */

export const BEHAVIOR_TASK_RESERVED_LLM_CALLS = 2;
export const BEHAVIOR_TASK_RESERVED_INPUT_TOKENS = 200_000;
export const BEHAVIOR_TASK_RESERVED_OUTPUT_TOKENS = 16_384;
export const BEHAVIOR_TASK_RESERVED_COST_AMOUNT = 2;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_DURATION_MS = 600_000;
const SCAN_LINES_PER_READ = 400;

export type InventoryExecute = (statement: string, parameters?: Array<string | number | null>) => Promise<[unknown[], unknown]>;

export interface InventoryFullAnalysisInput {
  run: RunContext;
  change: ChangeContext;
  repository: { owner: string; repo: string; revision: string };
  access: RepositoryAccess;
  provider?: CodeHostingProvider;
  scopeRoots: readonly SourceScopeRoot[];
  knownFeatureNames: string[];
  execute?: InventoryExecute;
  index?: OpenedRemoteSourceRevision;
  concurrency?: number;
  maxAttempts?: number;
  leaseDurationMs?: number;
  requestCompletion?: StructuredRequest;
}

export interface InventoryFullAnalysisOutcome {
  activated: boolean;
  result: MergeResult;
  coverage: AnalysisCoverageReceipt;
  enumerationMetrics: BehavioralEnumerationMetrics;
  passInfos: Array<{ retries: number; sanitize: EvidenceSanitizeSummary }>;
  mergeStats: { changesTruncated: number; scenariosDeduped: number; featuresFolded: number };
  behaviorLinks: AnchorScenarioLink[];
  gate: ActivationGateResult;
  unitStatuses: Array<{ unitKey: string; status: BehaviorUnitStatus }>;
  productDescriptionStatus: "generated" | "preserved" | "unavailable" | "not_run";
  tasks: { total: number; reusedTerminal: number; executed: number; pending: number };
}

const defaultExecute: InventoryExecute = (statement, parameters) =>
  getDb().execute(statement, parameters ?? []) as Promise<[unknown[], unknown]>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function isBudgetError(error: unknown, code: BehaviorBudgetError["code"]): boolean {
  return error instanceof BehaviorBudgetError && error.code === code;
}

function parseJsonColumn(raw: unknown): unknown {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

const zeroSanitize = (empty: boolean): EvidenceSanitizeSummary => ({
  droppedClaims: 0,
  droppedScenarios: 0,
  droppedFeatures: 0,
  allCandidatesRejected: false,
  empty,
  keptClaims: 0,
});

interface PersistedTaskRow {
  status: BehaviorUnitStatus | "running";
  attempts: number;
  result: BehaviorTaskExtractionResult | null;
}

/** 首跑扫描：实现面枚举 + 逐文件内容读取。读失败直接 throw（不持久化残缺 manifest）。 */
async function scanInventorySources(index: OpenedRemoteSourceRevision) {
  const surface = await enumerateImplementationSurface(index);
  const sources: Array<{ path: string; content: string }> = [];
  for (const entry of surface) {
    const lines: string[] = [];
    let startLine = 1;
    for (;;) {
      const slice = await index.readLines({
        path: entry.path,
        startLine,
        endLine: startLine + SCAN_LINES_PER_READ - 1,
        requestedBy: "behavioral_enumeration",
        reason: "behavior inventory scan",
      });
      lines.push(...slice.lines);
      if (slice.lines.length === 0 || slice.endLine >= slice.lineCount) break;
      startLine = slice.endLine + 1;
    }
    // 空文件（0 行）无可审行：排除出 sources（不是不可读，不造 placeholder 单元）
    if (lines.length === 0) continue;
    sources.push({ path: entry.path, content: lines.join("\n") });
  }
  return sources;
}

async function ensureTaskRows(execute: InventoryExecute, runId: number, manifest: BehaviorManifest): Promise<void> {
  const unitsByKey = new Map(manifest.units.map((unit) => [unit.unitKey, unit]));
  for (const task of manifest.tasks) {
    const unit = unitsByKey.get(task.unitKey);
    if (!unit) throw new Error(`manifest task ${task.taskKey} references unknown unit ${task.unitKey}`);
    await execute(
      `INSERT IGNORE INTO analysis_behavior_tasks
         (run_id, task_key, task_key_hash, unit_key, unit_key_hash, kind, primary_path,
          primary_ranges, context_ranges, anchor_fragments, detector, detector_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        task.taskKey,
        sha256(task.taskKey),
        unit.unitKey,
        sha256(unit.unitKey),
        unit.kind,
        unit.primaryPath,
        unit.primaryRanges == null ? null : JSON.stringify(unit.primaryRanges),
        JSON.stringify(unit.contextRanges),
        JSON.stringify(task.anchorFragments),
        unit.detector,
        unit.detectorVersion,
      ],
    );
  }
}

async function ensureBudgetRow(execute: InventoryExecute, runId: number): Promise<void> {
  const caps = behaviorAnalysisBudget();
  await execute(
    `INSERT IGNORE INTO analysis_run_budgets (run_id, max_llm_calls, max_total_tokens, max_cost_amount, currency)
     VALUES (?, ?, ?, ?, ?)`,
    [
      runId,
      caps.maxLlmCalls ?? UNLIMITED_MAX_LLM_CALLS,
      caps.maxTotalTokens ?? UNLIMITED_MAX_TOTAL_TOKENS,
      caps.maxCostAmount != null ? caps.maxCostAmount.toFixed(6) : UNLIMITED_MAX_COST_AMOUNT,
      caps.currency,
    ],
  );
}

async function loadPersistedTaskRows(execute: InventoryExecute, runId: number): Promise<Map<string, PersistedTaskRow>> {
  const [rows] = await execute(
    "SELECT task_key, status, attempts, result_json FROM analysis_behavior_tasks WHERE run_id = ?",
    [runId],
  );
  const map = new Map<string, PersistedTaskRow>();
  for (const row of rows as Array<{ task_key: unknown; status: unknown; attempts: unknown; result_json: unknown }>) {
    const status = String(row.status) as PersistedTaskRow["status"];
    const result = row.result_json == null ? null : (parseJsonColumn(row.result_json) as BehaviorTaskExtractionResult);
    map.set(String(row.task_key), { status, attempts: Number(row.attempts), result });
  }
  return map;
}

function isReusableTerminal(row: PersistedTaskRow | undefined): boolean {
  return row != null && (row.status === "extracted" || row.status === "no_behavior") && row.result != null;
}

/** 任务源码可读性硬校验：任何 source 内容为空或区间倒挂都视为不可读，走硬失败路径。 */
function assertSourcesReadable(sources: TaskSource[]): void {
  for (const source of sources) {
    if (source.content === "" || source.endLine < source.startLine) {
      throw new Error(`behavior task source unreadable: ${source.path}#${source.startLine}-${source.endLine}`);
    }
  }
}

interface DispatchState {
  stopDispatch: boolean;
  budgetBlocked: boolean;
  fatal: unknown;
  executed: number;
  passInfos: Array<{ retries: number; sanitize: EvidenceSanitizeSummary }>;
}

function buildGateAnchors(
  manifest: BehaviorManifest,
  unitStates: Map<string, UnitTaskState[]>,
  localKeyByTaskRef: ReadonlyMap<string, string>,
): ActivationGateAnchor[] {
  const anchors: ActivationGateAnchor[] = [];
  for (const unit of manifest.units) {
    const states = unitStates.get(unit.unitKey) ?? [];
    for (const anchor of unit.anchors) {
      const receipts: Array<{ receipt: NonNullable<UnitTaskState["result"]>["anchorReceipts"][number] | null; taskKey: string }> = [];
      for (const state of states) {
        for (const fragment of state.task.anchorFragments) {
          if (fragment.anchorKey !== anchor.anchorKey) continue;
          const receipt = state.result?.anchorReceipts.find((candidate) => candidate.anchorFragmentKey === fragment.anchorFragmentKey) ?? null;
          receipts.push({ receipt, taskKey: state.task.taskKey });
        }
      }
      let disposition: ActivationGateAnchor["disposition"];
      if (receipts.length === 0 || receipts.some((entry) => entry.receipt == null) || receipts.some((entry) => entry.receipt?.disposition === "unresolved")) {
        disposition = "unresolved";
      } else if (receipts.some((entry) => entry.receipt?.disposition === "extracted")) {
        disposition = "extracted";
      } else {
        disposition = "reviewed_internal";
      }
      const evidence: unknown[] = [];
      const seenEvidence = new Set<string>();
      const relatedUnitKeys = new Set<string>();
      const relatedScenarioRefs = new Set<string>();
      let internalKind: string | undefined;
      for (const { receipt, taskKey } of receipts) {
        if (receipt == null) continue;
        for (const item of receipt.evidence) {
          const id = `${item.path}:${item.startLine ?? ""}`;
          if (seenEvidence.has(id)) continue;
          seenEvidence.add(id);
          evidence.push(item);
        }
        for (const key of receipt.relatedUnitKeys ?? []) relatedUnitKeys.add(key);
        for (const ref of receipt.relatedScenarioRefs ?? []) {
          relatedScenarioRefs.add(localKeyByTaskRef.get(`${taskKey}\n${ref}`) ?? ref);
        }
        if (receipt.internalKind === "covered_elsewhere") internalKind = "covered_elsewhere";
        else if (internalKind == null && receipt.internalKind != null) internalKind = receipt.internalKind;
      }
      const gateAnchor: ActivationGateAnchor = { anchorKey: anchor.anchorKey, role: anchor.role, disposition, evidence };
      if (internalKind != null) gateAnchor.internalKind = internalKind;
      if (relatedUnitKeys.size > 0) gateAnchor.relatedUnitKeys = [...relatedUnitKeys].sort();
      if (relatedScenarioRefs.size > 0) gateAnchor.relatedScenarioRefs = [...relatedScenarioRefs].sort();
      anchors.push(gateAnchor);
    }
  }
  return anchors;
}

function parseSurvivingUnitKeys(originKeys: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const origin of originKeys) {
    if (!origin.startsWith("scenario|")) continue;
    try {
      const tuple = JSON.parse(origin.slice("scenario|".length)) as unknown;
      if (Array.isArray(tuple) && typeof tuple[0] === "string") keys.add(tuple[0]);
    } catch {
      // 非本管线格式的 origin（旧分区结果）不参与单元存活集
    }
  }
  return keys;
}

export async function runInventoryFullAnalysis(
  input: InventoryFullAnalysisInput,
  options: { activate: boolean },
): Promise<InventoryFullAnalysisOutcome> {
  const execute = input.execute ?? defaultExecute;
  const runId = input.run.id;
  const outputLanguage: OutputLanguage = input.run.outputLanguage ?? "zh-CN";
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const concurrency = Math.max(1, input.concurrency ?? behaviorAnalysisConcurrency());
  const index = input.index ?? (await createRemoteSourceIndex(
    { owner: input.repository.owner, repo: input.repository.repo, revision: input.repository.revision },
    { scopeRoots: [...input.scopeRoots], access: input.access, provider: input.provider, budgets: analysisSourceIndexBudgets },
  ));

  // ---- manifest：存在则校验加载（tampered/conflict 直接传播），不存在则首跑扫描插入 ----
  const [manifestProbe] = await execute("SELECT run_id FROM analysis_behavior_manifests WHERE run_id = ?", [runId]);
  let manifest: BehaviorManifest;
  if ((manifestProbe as unknown[]).length > 0) {
    try {
      manifest = await loadVerifiedManifest(execute, runId);
    } catch (error) {
      // 持久化错误的 code（inventory_manifest_tampered / inventory_version_conflict）必须进入
      // 抛出消息——run 失败落库的 error_message 是恢复故障的唯一现场，裸 message 丢失类别。
      if (error instanceof InventoryPersistenceError) {
        throw new InventoryPersistenceError(error.code, `${error.code}: ${error.message}`);
      }
      throw error;
    }
  } else {
    const sources = await scanInventorySources(index);
    const inventory = buildBehaviorInventory({
      afterSha: input.run.afterSha,
      scopeRoots: input.scopeRoots.map((scope) => scope.path),
      sources,
    });
    const tasks = planBehaviorExecutionTasks({ units: inventory.units, sources });
    manifest = {
      inventorySchemaVersion: inventory.inventorySchemaVersion,
      detectorRegistryVersion: inventory.detectorRegistryVersion,
      afterSha: inventory.afterSha,
      scopeFingerprint: inventory.scopeFingerprint,
      units: inventory.units,
      tasks,
    };
    await insertManifestIfAbsent(execute, runId, manifest);
  }
  const unitsByKey = new Map(manifest.units.map((unit) => [unit.unitKey, unit]));

  // ---- 任务行（幂等补崩溃窗口）+ 预算行 + 摘要预留（activate，先于任何任务预留）----
  await ensureTaskRows(execute, runId, manifest);
  await ensureBudgetRow(execute, runId);
  // 摘要预留先于任何任务预留（D9：摘要份额不被单元抢占）；shadow 不预留不生成。
  // 摘要首次 LLM 调用前的任何退出（门禁失败/派发致命错误/数据异常）都必须经 Task 7
  // fix round 2 的安全路径释放该预挂号预留（同事务复位 summary_reserved，见末尾 catch）；
  // 进入共享解析器后由它恰好 settle 一次（summaryHandedOff 置位，绝不重复释放）。
  const summaryReservation = options.activate ? await reserveProductSummaryBudget(runId) : null;
  let summaryHandedOff = false;
  try {
    // ---- 调度：worker pool，每任务固定 reserve → claim ----
    const rowsBefore = await loadPersistedTaskRows(execute, runId);
    const eligible = manifest.tasks.filter((task) => !isReusableTerminal(rowsBefore.get(task.taskKey)));
    const reusedTerminal = manifest.tasks.length - eligible.length;
    const state: DispatchState = { stopDispatch: false, budgetBlocked: false, fatal: null, executed: 0, passInfos: [] };
    const leaseOwner = `inventory-${runId}-${randomUUID()}`;
    const queue = [...eligible];

    const safeSettle = async (reservationId: string): Promise<void> => {
      try {
        await settleBehaviorBudget({ reservationId });
      } catch (error) {
        if (isBudgetError(error, "behavior_budget_usage_unknown")) {
          // 上限已配置但用量回执缺失：停止派发并记 budgetBlocked（门禁 fail closed），不 rethrow
          state.stopDispatch = true;
          state.budgetBlocked = true;
          return;
        }
        throw error;
      }
    };

    const processTask = async (task: BehaviorExecutionTask): Promise<void> => {
      const unit = unitsByKey.get(task.unitKey);
      if (!unit) throw new Error(`manifest task ${task.taskKey} references unknown unit ${task.unitKey}`);
      let attemptsThisRun = 0;
      for (;;) {
        let reservation: Awaited<ReturnType<typeof reserveBehaviorBudget>>;
        try {
          reservation = await reserveBehaviorBudget({
            runId,
            attemptId: randomUUID(),
            maxLlmCalls: BEHAVIOR_TASK_RESERVED_LLM_CALLS,
            maxInputTokens: BEHAVIOR_TASK_RESERVED_INPUT_TOKENS,
            maxOutputTokens: BEHAVIOR_TASK_RESERVED_OUTPUT_TOKENS,
            maxCostAmount: BEHAVIOR_TASK_RESERVED_COST_AMOUNT,
          });
        } catch (error) {
          if (isBudgetError(error, "behavior_budget_exceeded")) {
            // 预算不足以覆盖预留：绝不领取租约，停止派发（不消耗任何 attempt）
            state.stopDispatch = true;
            state.budgetBlocked = true;
            return;
          }
          throw error;
        }
        const claimed = await claimBehaviorTask({ execute, runId, taskKey: task.taskKey, leaseOwner, leaseDurationMs, maxAttempts });
        if (!claimed) {
          // 领取失败（被抢占/重试预算耗尽）：预留未发生任何调用，立即全额释放，绝不 settle
          await releaseUnusedBehaviorBudget(reservation.reservationId);
          return;
        }
        if (state.stopDispatch) {
          // 已领取但首次 LLM 调用前收到停止信号：全额释放 + 恢复 pending（不记伪失败）
          await releaseUnusedBehaviorBudget(reservation.reservationId);
          await markBehaviorTaskFailure({
            execute,
            runId,
            taskKey: task.taskKey,
            attemptId: claimed.attemptId,
            leaseOwner,
            error: "dispatch stopped before first LLM call",
            abortedBeforeExecution: true,
          });
          return;
        }
        attemptsThisRun += 1;
        let result: BehaviorTaskExtractionResult;
        try {
          const sources = await loadBehaviorTaskSources(index, task, unit);
          assertSourcesReadable(sources);
          const billing: LlmBillingContext = {
            runId,
            accountId: input.run.accountId ?? null,
            chargeComponent: options.activate ? "main" : "platform_shadow",
            taskKey: task.taskKey,
            unitKey: unit.unitKey,
            // LLM 计费身份 = 预留 attemptId（settle 按预留聚合实际回执）；claim.attemptId 是租约身份
            attemptId: reservation.attemptId,
          };
          result = await extractBehaviorTask({
            task,
            sources,
            billing,
            knownFeatureNames: input.knownFeatureNames,
            outputLanguage,
            label: `inventory/${runId}/${task.taskKey.slice(0, 48)}`,
          });
          state.executed += 1;
        } catch (error) {
          // 硬失败（网关/超时/源不可读）：记 failed（消耗 attempt），settle 后按预算重试
          await markBehaviorTaskFailure({ execute, runId, taskKey: task.taskKey, attemptId: claimed.attemptId, leaseOwner, error: errorMessage(error) });
          await safeSettle(reservation.reservationId);
          if (claimed.attempts < maxAttempts && !state.stopDispatch) continue;
          state.passInfos.push({ retries: attemptsThisRun - 1, sanitize: zeroSanitize(true) });
          return;
        }
        const committed = await commitBehaviorTaskResult({
          execute,
          runId,
          taskKey: task.taskKey,
          attemptId: claimed.attemptId,
          leaseOwner,
          outcome: result.outcome,
          result,
          scenarioCount: result.scenarioCount,
          reviewedCount: result.reviewedCount,
          unresolvedAnchorCount: result.unresolvedAnchorCount,
        });
        if (!committed) {
          console.warn("[full-analysis] stale attempt commit rejected; kept existing terminal result", { runId, taskKey: task.taskKey, attemptId: claimed.attemptId });
        }
        await safeSettle(reservation.reservationId);
        state.passInfos.push({ retries: attemptsThisRun - 1, sanitize: result.sanitize });
        return;
      }
    };

    const worker = async (): Promise<void> => {
      try {
        // stopDispatch 不在取任务处短路：剩余任务仍走 reserve → claim → abort 排水路径
        // （释放预留 + 恢复 pending），保证不留下悬挂租约与未释放预留。
        while (state.fatal == null) {
          const task = queue.shift();
          if (!task) return;
          await processTask(task);
        }
      } catch (error) {
        state.fatal ??= error;
        state.stopDispatch = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, () => worker()));
    if (state.fatal != null) throw state.fatal;

    // ---- 聚合：重读持久化行 → 单元状态 / 局部场景身份 / 锚点关联 ----
    const rowsAfter = await loadPersistedTaskRows(execute, runId);
    const unitStates = new Map<string, UnitTaskState[]>();
    for (const unit of manifest.units) {
      const states: UnitTaskState[] = manifest.tasks
        .filter((task) => task.unitKey === unit.unitKey)
        .map((task) => {
          const row = rowsAfter.get(task.taskKey);
          const terminal = row != null && (row.status === "extracted" || row.status === "no_behavior" || row.status === "unresolved") && row.result != null;
          return {
            task,
            status: (row?.status ?? "pending") as UnitTaskState["status"],
            result: terminal ? row.result : null,
          };
        });
      unitStates.set(unit.unitKey, states);
    }
    const unitStatuses: Array<{ unitKey: string; status: BehaviorUnitStatus }> = [];
    const assignmentsByUnit = new Map<string, LocalScenarioKeyAssignment[]>();
    const localKeyByTaskRef = new Map<string, string>();
    for (const unit of manifest.units) {
      const states = unitStates.get(unit.unitKey) ?? [];
      const status = aggregateBehaviorUnitStatus({ unit, tasks: states });
      unitStatuses.push({ unitKey: unit.unitKey, status });
      const assignments = assignLocalScenarioKeys({ unit, tasks: states });
      assignmentsByUnit.set(unit.unitKey, assignments);
      for (const assignment of assignments) {
        localKeyByTaskRef.set(`${assignment.taskKey}\n${assignment.reference}`, assignment.localScenarioKey);
      }
    }

    // ---- 合并：每 unit 一 chunk（按 featureName 分组），mergeBehaviorTaskResults 确定性合并 ----
    const releaseTitle = (input.change.message ?? "").split("\n")[0].trim().slice(0, 120)
      || (outputLanguage === "en" ? "Inventory full rebuild" : "行为清单全量重建");
    const releaseSummary = outputLanguage === "en"
      ? "Inventory-based full rebuild: release notes are projected from the merged spec facts, not inferred from commit messages."
      : "行为清单全量重建：发布说明由合并后的规格事实统一投影，不由提交消息推断。";
    const chunks: ExtractionChunk[] = manifest.units.map((unit) => {
      const assignments = assignmentsByUnit.get(unit.unitKey) ?? [];
      const states = unitStates.get(unit.unitKey) ?? [];
      const byFeature = new Map<string, LocalScenarioKeyAssignment[]>();
      for (const assignment of assignments) {
        byFeature.set(assignment.featureName, [...(byFeature.get(assignment.featureName) ?? []), assignment]);
      }
      const features = [...byFeature.entries()].map(([name, list]) => {
        let summary = "";
        for (const state of states) {
          const match = state.result?.features.find((feature) => feature.name === name);
          if (match) {
            summary = match.summary;
            break;
          }
        }
        return { name, summary, scenarios: list.map((assignment) => ({ ...assignment.scenario, originKeys: [assignment.localScenarioKey] })) };
      });
      return {
        result: {
          product: { description: "", evidence: [] },
          release: { title: releaseTitle, summary: releaseSummary },
          changes: [],
          features,
        },
        anchorLinks: buildAnchorScenarioLinks({ runId, unitKey: unit.unitKey, assignments }),
      };
    });
    const merged = mergeBehaviorTaskResults(chunks);

    // ---- 覆盖（门禁口径）：eligibleRanges 取全部单元主区间并集（恢复路径无需重读文件） ----
    const eligibleRanges: CodeRange[] = manifest.units.flatMap((unit) =>
      (unit.primaryRanges ?? []).map((range) => ({ path: unit.primaryPath, startLine: range.startLine, endLine: range.endLine })),
    );
    const inventoryCoverage = evaluateInventoryCoverage({ eligibleRanges, units: manifest.units, tasks: manifest.tasks });

    // ---- 激活门禁（D8：fail closed） ----
    const survivingOriginKeys = merged.result.features.flatMap((feature) => feature.scenarios.flatMap((scenario) => scenario.originKeys ?? []));
    const survivingScenarioRefs = new Set(survivingOriginKeys);
    const survivingUnitKeys = parseSurvivingUnitKeys(survivingOriginKeys);
    const gateAnchors = buildGateAnchors(manifest, unitStates, localKeyByTaskRef);
    const existingEvidenceChecksPassed = [...rowsAfter.values()]
      .every((row) => row.result == null || row.result.sanitize?.allCandidatesRejected !== true);
    const gate = evaluateBehaviorActivationGate({
      manifestValid: true,
      primaryCoverageComplete: inventoryCoverage.primaryCoverage.complete,
      anchorCoverageComplete: inventoryCoverage.anchorCoverage.complete && inventoryCoverage.diagnostics.unresolvedUnits.length === 0,
      anchors: gateAnchors,
      unitStatuses: unitStatuses.map((entry) => entry.status),
      survivingUnitKeys,
      survivingScenarioRefs,
      existingEvidenceChecksPassed,
      existingMergeChecksPassed: true,
    });

    const activated = gate.activate && !state.budgetBlocked;
    if (!activated) {
      const failedChecks = Object.entries(gate.checks).filter(([, passed]) => !passed).map(([name]) => name);
      console.error("[full-analysis] activation gate failed", {
        runId,
        failedChecks,
        budgetBlocked: state.budgetBlocked,
        unaccountedAnchorKeys: gate.unaccountedAnchorKeys,
      });
      if (options.activate) {
        const reason = failedChecks.length > 0 ? failedChecks.join(",") : "budget_settlement_unknown";
        throw new Error(`inventory_activation_gate_failed:${reason}`);
      }
    }

    // ---- 锚点关联行落库（仅 activate 且过门禁；INSERT IGNORE 幂等） ----
    if (options.activate && activated) {
      for (const link of merged.anchorLinks) {
        await execute(
          `INSERT IGNORE INTO analysis_behavior_anchor_scenarios
             (run_id, unit_key, unit_key_hash, anchor_key, anchor_key_hash, local_scenario_key, local_scenario_key_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [runId, link.unitKey, sha256(link.unitKey), link.anchorKey, sha256(link.anchorKey), link.localScenarioKey, sha256(link.localScenarioKey)],
        );
      }
    }

    // ---- 产品简介（仅 activate 且过门禁；证据面=合并面，走 Task 12 共享解析器） ----
    let product: ProductDescriptionOutcome["product"] = { description: "", evidence: [] };
    let productDescriptionStatus: InventoryFullAnalysisOutcome["productDescriptionStatus"] = "not_run";
    if (options.activate && activated && summaryReservation != null) {
      const [productRows] = await execute("SELECT description, description_evidence FROM products WHERE id = ?", [input.run.productId]);
      const productRow = (productRows as Array<{ description?: unknown; description_evidence?: unknown }>)[0];
      const previousDescription = typeof productRow?.description === "string" ? productRow.description : "";
      const previousLanguage = await loadLatestSpecVersionLanguage(input.run.repositoryId, execute);
      const previous = previousDescription.trim() === ""
        ? null
        : {
            description: previousDescription,
            evidence: (Array.isArray(parseJsonColumn(productRow?.description_evidence ?? "[]")) ? parseJsonColumn(productRow?.description_evidence ?? "[]") : []) as Evidence[],
            language: previousLanguage,
          };
      try {
        const resolution = await resolveProductDescription({
          runId,
          accountId: input.run.accountId ?? null,
          mergedFeatures: merged.result.features,
          outputLanguage,
          previous,
          // 预挂号预留传入：解析器跳过 reserve、恰好 settle 一次（usage 未知硬阻断透传）
          reservation: summaryReservation,
          requestCompletion: input.requestCompletion,
        });
        product = resolution.product;
        productDescriptionStatus = resolution.status;
      } finally {
        // 进入解析器即视为已移交结算职责（含 settle 抛错前已保守入账）——绝不重复释放
        summaryHandedOff = true;
      }
    }

    // ---- B1 覆盖回执（unit 派生，首跑/恢复同口径） ----
    const unitPaths = [...new Set(manifest.units.map((unit) => unit.primaryPath))].sort();
    let implBytesTotal = 0;
    for (const path of unitPaths) {
      const stat = await index.statPath(path);
      implBytesTotal += stat?.byteSize ?? 0;
    }
    const terminalTaskCount = [...rowsAfter.values()].filter(
      (row) => row.status === "extracted" || row.status === "no_behavior" || row.status === "unresolved",
    ).length;
    const diffPaths = input.change.files.map((file) => file.path);
    const unitPathSet = new Set(unitPaths);
    const diffSelectedPaths = diffPaths.filter((path) => unitPathSet.has(path) || evidenceKind(path) !== "implementation").length;
    const coverage: AnalysisCoverageReceipt = {
      implFilesAssembled: unitPaths.length,
      implFilesTotal: unitPaths.length,
      implBytesAssembled: implBytesTotal,
      implBytesTotal,
      coverageRatio: 1,
      partitionsUsed: terminalTaskCount,
      partitionsCapped: false,
      diffTotalPaths: diffPaths.length,
      diffSelectedPaths,
      diffOmittedPaths: diffPaths.length - diffSelectedPaths,
      // Task 14：新路径回执必须带主覆盖区间遗漏——完整性账本的 sourceCoverage complete
      // 要求该值为零，不能仅凭「装配数大于零且未触分区帽」推导（设计 §6.3）。
      primaryRangesOmitted: inventoryCoverage.primaryCoverage.uniqueLinesOmitted,
    };

    // Task 14：W0-8 diff 枚举字段在本路径保持全零 + not_applicable（分组枚举是旧分区
    // 路径的增强层）；inventory 编排的完整性披露挂在可选 inventory 详情上——单元/锚点
    // 状态、coarse/implicit/fallback 计数、租约与预算、摘要状态、恢复任务会计。
    const taskRows = [...rowsAfter.values()];
    const unitStatusCount = (status: BehaviorUnitStatus) => unitStatuses.filter((entry) => entry.status === status).length;
    const allAnchors = manifest.units.flatMap((unit) => unit.anchors);
    const inventorySummary: InventoryEnumerationSummary = {
      unitsTotal: manifest.units.length,
      unitsPending: unitStatusCount("pending"),
      unitsRunning: unitStatusCount("running"),
      unitsExtracted: unitStatusCount("extracted"),
      unitsNoBehavior: unitStatusCount("no_behavior"),
      unitsUnresolved: unitStatusCount("unresolved"),
      unitsFailed: unitStatusCount("failed"),
      anchorsTotal: allAnchors.length,
      entryAnchors: allAnchors.filter((anchor) => anchor.role === "entry").length,
      behaviorAnchors: allAnchors.filter((anchor) => anchor.role === "behavior").length,
      implicitReviewAnchors: allAnchors.filter((anchor) => anchor.role === "implicit_review").length,
      coarseReviewAnchors: allAnchors.filter((anchor) => anchor.role === "implicit_review" && anchor.coarse).length,
      semanticUnits: manifest.units.filter((unit) => unit.detector !== RESIDUAL_DETECTOR_ID).length,
      residualUnits: manifest.units.filter((unit) => unit.detector === RESIDUAL_DETECTOR_ID).length,
      unreadableUnits: inventoryCoverage.diagnostics.unreadableUnits.length,
      primaryRangesCoveredLines: inventoryCoverage.primaryCoverage.uniqueLinesCovered,
      primaryRangesOmittedLines: inventoryCoverage.primaryCoverage.uniqueLinesOmitted,
      anchorRangesCoveredLines: inventoryCoverage.anchorCoverage.uniqueLinesCovered,
      anchorRangesOmittedLines: inventoryCoverage.anchorCoverage.uniqueLinesOmitted,
      tasksTotal: manifest.tasks.length,
      tasksReusedTerminal: reusedTerminal,
      tasksExecuted: state.executed,
      tasksPending: manifest.tasks.length - reusedTerminal - state.executed,
      leasesHeld: taskRows.filter((row) => row.status === "running").length,
      attemptsTotal: taskRows.reduce((sum, row) => sum + row.attempts, 0),
      budgetBlocked: state.budgetBlocked,
      productDescriptionStatus,
    };
    const enumerationMetrics: BehavioralEnumerationMetrics = {
      pathsTotal: 0,
      pathsEnumerated: 0,
      pathsOmitted: 0,
      hunksTotal: 0,
      hunksTruncated: 0,
      groupsTotal: 0,
      groupsCompleted: 0,
      groupsFailed: 0,
      status: "not_applicable",
      inventory: inventorySummary,
    };

    return {
      activated,
      result: { ...merged.result, product },
      coverage,
      enumerationMetrics,
      passInfos: state.passInfos,
      mergeStats: merged.stats,
      behaviorLinks: merged.anchorLinks,
      gate,
      unitStatuses,
      productDescriptionStatus,
      tasks: {
        total: manifest.tasks.length,
        reusedTerminal,
        executed: state.executed,
        pending: manifest.tasks.length - reusedTerminal - state.executed,
      },
    };
  } catch (error) {
    // 摘要首次 LLM 调用前的任何退出：经 Task 7 fix round 2 的安全路径释放预挂号的摘要
    // 预留（同事务复位 summary_reserved），绝不泄漏每 run 份额；释放失败不掩盖原始错误。
    if (summaryReservation != null && !summaryHandedOff) {
      try {
        await releaseUnusedBehaviorBudget(summaryReservation.reservationId);
      } catch (releaseError) {
        console.error("[full-analysis] product summary reservation release failed after abort", { runId, message: errorMessage(releaseError) });
      }
    }
    throw error;
  }
}
