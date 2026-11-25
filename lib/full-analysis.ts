import { createHash, randomUUID } from "node:crypto";
import { type LlmBillingContext } from "./ai";
import type { OutputLanguage } from "./analysis-language";
import type { RunContext } from "./analysis";
import { enumerateImplementationSurface, type AnalysisCoverageReceipt } from "./analysis-coverage";
import type { BehavioralEnumerationMetrics, InventoryEnumerationSummary } from "./behavioral-enumeration";
import { evaluateBehaviorActivationGate, resolveProductDescription, type ActivationGateAnchor, type ActivationGateResult, type ProductDescriptionOutcome } from "./behavior-activation";
import { buildBehaviorInventory, computeScopeFingerprint, RESIDUAL_DETECTOR_ID } from "./behavior-inventory";
import { evaluateInventoryCoverage } from "./behavior-inventory/coverage";
import { loadBehaviorTaskSources, planBehaviorExecutionTasks, type TaskSource } from "./behavior-inventory/planner";
import { behaviorAnalysisExecutionMode } from "./env";
import { fragmentIsBlank, primaryLineIndexOf } from "./behavior-unit-extraction";
import { sha256Utf8 } from "./execution-batch/identity";
import { planBehaviorExecutionBatches } from "./execution-batch/planner";
import { publishBehaviorBatchPlanSet } from "./execution-batch/plans";
import { routeBatchWorkItems, runInventoryBatchAttempt, recoverInventoryBatchAttempts, type BatchWorkItem } from "./execution-batch/runner";
import type { BehaviorExecutionTask, BehaviorManifest, BehaviorUnit } from "./behavior-inventory/types";
import { mergeBehaviorTaskResults } from "./behavior-result-merge";
import {
  BehaviorBudgetError,
  UNLIMITED_MAX_COST_AMOUNT,
  UNLIMITED_MAX_LLM_CALLS,
  UNLIMITED_MAX_TOTAL_TOKENS,
  reconcileOrphanedTaskReservations,
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
  renewBehaviorTaskLease,
} from "./behavior-unit-receipts";
import {
  aggregateBehaviorUnitStatus,
  assignLocalScenarioKeysWithAliases,
  buildAnchorScenarioLinks,
  type AnchorScenarioLink,
  type BehaviorUnitStatus,
  type LocalScenarioKeyAssignment,
  type UnitTaskState,
} from "./behavior-unit-state";
import { behaviorAnalysisBudget, behaviorAnalysisConcurrency } from "./env";
import { analyzedChangePaths, evidenceKind } from "./evidence";
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
 * - 观测（Task 14/15）：coverage 回执带主覆盖区间遗漏（新路径 sourceCoverage complete
 *   要求为零）；enumerationMetrics 的 inventory 详情记录单元/锚点状态、coarse/
 *   implicit/fallback 计数、清单生成诊断（D：detector 失败面与不可读路径，随 manifest
 *   持久化，恢复同口径）、租约与预算、摘要状态与恢复任务会计——恢复复用的成功
 *   任务计入 tasksReusedTerminal，绝不计为本 run 新执行的提取趟；tasksExecuted 含
 *   发起后硬失败的任务（attempt 级会计在 attemptsTotal），tasksPending 按持久化行
 *   status='pending' 字面计数（Task 15 修正，失败任务不再被误报为 pending）。
 * - 审查修复轮（2026-11-19 review wave）：
 *   B 摘要预留携带服务端状态——恢复拿到已结算预留时绝不重新生成（usage 无法二次入账），
 *     按 D10 降级（语言一致 preserved / 否则 unavailable）；settled_unknown 等价
 *     usage 未知硬阻断（停止派发 + 门禁 fail closed）。
 *   C 恢复重算范围指纹（目录枚举元数据级，不读文件内容），与持久化指纹不一致即
 *     inventory_version_conflict，绝不静默重扫自愈。
 *   E 恢复在派发前对账孤儿任务预留（usageUnknownBlocked → 停止派发 + 门禁 fail closed）。
 *   F 执行窗口（源加载 + 提取 + 复核）内的租约心跳续约；续约失败视为硬失败，绝不提交。
 *   G existingMergeChecksPassed 由合并统计派生（截断计数 >0 即不通过），不再硬编码 true。
 *   H 任务源码区间倒挂（读取缺行）视为不可读（硬失败路径）；纯空行区域改由提取层
 *     确定性判 no_code_content（零 AI 调用），不再误判为不可读（2026-11-20 修正轮）。
 *   I unresolved 且仍有未决回执时同 attempt 内做一次语义复核（repair），复核趟与首趟
 *     共用同一预留（settle 按实际回执入账，超预留不截断、仅受 run 上限约束）。
 *   K 覆盖判定的 eligibleRanges 取 manifest 持久化诊断（独立真源），不从单元主区间反推。
 *   related-ref：covered_elsewhere 的 relatedUnitKeys 只保留 manifest 单元集合内的 key
 *     （幽灵 key 丢弃，丢完无关联即回 unresolved 由门禁 fail closed）；派发时向判定
 *     prompt 传有效单元 key 目录（knownUnitKeys，截断 150）。relatedScenarioRefs 经
 *     局部身份映射 + 去重候选别名解析到存活场景（2026-11-20 修正轮），解析不到仍
 *     fail closed。
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

/**
 * 窗口 diff 的覆盖口径，与分区路径的 computeCoverageReceipt 用同一个判定：只数分析目标内的改动文件，
 * 迁移脚本不算遗漏。进了单元的算覆盖；本来就不在实现面的（测试、文档）不需要覆盖，也算覆盖。
 */
export function diffPathCoverage(changeFiles: ReadonlyArray<{ path: string }>, unitPaths: readonly string[]) {
  const diffPaths = analyzedChangePaths(changeFiles);
  const unitPathSet = new Set(unitPaths);
  const diffSelectedPaths = diffPaths.filter((path) => unitPathSet.has(path) || evidenceKind(path) !== "implementation").length;
  return { diffTotalPaths: diffPaths.length, diffSelectedPaths, diffOmittedPaths: diffPaths.length - diffSelectedPaths };
}

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

/**
 * 任务源码结构性硬校验：区间倒挂（读取缺行，多为 surface 漂移竞态）视为不可读，走硬失败路径。
 * 纯空行内容不再是硬失败（H 修正）：声明间空行产生的纯空 residual 区域由提取层确定性
 * 判为 no_code_content（零 AI 调用），不再误判为不可读导致全量分析无法激活。
 */
function assertSourcesReadable(sources: TaskSource[]): void {
  for (const source of sources) {
    if (source.endLine < source.startLine) {
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
  // related-reference 防线：relatedUnitKeys 只保留 manifest 单元集合内的 key——幽灵 key
  // （模型幻觉/跨 run 漂移）直接丢弃；丢完无关联的 covered_elsewhere 锚点在门禁回
  // unresolved（fail closed），绝不凭不可解析的关联放行。
  const validUnitKeys = new Set(manifest.units.map((unit) => unit.unitKey));
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
        for (const key of receipt.relatedUnitKeys ?? []) {
          if (validUnitKeys.has(key)) relatedUnitKeys.add(key);
        }
        // relatedScenarioRefs 解析：先直查（存活候选的身份映射），再去重别名（行为等价
        // 去重丢弃候选 → keeper 局部身份）；两层都落空的引用保持原样，门禁 fail closed。
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
  // 恢复启动时刻（E：孤儿预留对账的创建时间截止线，排除本进程在途 attempt）
  const runStartedAtMs = Date.now();
  const index = input.index ?? (await createRemoteSourceIndex(
    { owner: input.repository.owner, repo: input.repository.repo, revision: input.repository.revision },
    { scopeRoots: [...input.scopeRoots], access: input.access, provider: input.provider, budgets: analysisSourceIndexBudgets },
  ));

  // ---- manifest：存在则校验加载（tampered/conflict 直接传播），不存在则首跑扫描插入 ----
  const [manifestProbe] = await execute("SELECT run_id FROM analysis_behavior_manifests WHERE run_id = ?", [runId]);
  const resumed = (manifestProbe as unknown[]).length > 0;
  let orphanUsageUnknownBlocked = false;
  let manifest: BehaviorManifest;
  if (resumed) {
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
    // C：恢复按目录枚举（元数据级，不读文件内容）重算范围指纹并与持久化值比对——实现面
    // 已漂移的 manifest 不可恢复，抛 inventory_version_conflict（绝不静默重扫自愈）。
    // 路径口径与首跑扫描一致：0 字节文件无可审行，不参与指纹。
    const surface = await enumerateImplementationSurface(index);
    const currentFingerprint = computeScopeFingerprint(
      surface.filter((entry) => entry.size > 0).map((entry) => entry.path),
      input.scopeRoots.map((scope) => scope.path),
    );
    if (currentFingerprint !== manifest.scopeFingerprint) {
      throw new InventoryPersistenceError(
        "inventory_version_conflict",
        `inventory_version_conflict: run ${runId} implementation surface changed since the manifest was persisted (scope fingerprint mismatch); create a new run instead of resuming`,
      );
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
      // D/K：清单生成诊断随 manifest 持久化（hash 保护）——恢复路径的诊断暴露与
      // eligibleRanges 覆盖判定都以此为独立真源。
      diagnostics: inventory.diagnostics,
    };
    await insertManifestIfAbsent(execute, runId, manifest);
  }
  const unitsByKey = new Map(manifest.units.map((unit) => [unit.unitKey, unit]));

  // ---- 任务行（幂等补崩溃窗口）+ 预算行 + 孤儿对账（E，仅恢复）+ 摘要预留（先于任务预留）----
  await ensureTaskRows(execute, runId, manifest);
  await ensureBudgetRow(execute, runId);
  if (resumed) {
    // E：进程崩溃会留下 status='reserved' 的任务预留，永不结算、聚合计数永久泄漏。
    // 恢复在派发前了断孤儿（有回执结算 / 零回执释放）；usage 未知等价 budgetBlocked。
    const orphans = await reconcileOrphanedTaskReservations({ runId, orphanBeforeMs: runStartedAtMs });
    orphanUsageUnknownBlocked = orphans.usageUnknownBlocked;
  }
  // 摘要预留先于任何任务预留（D9：摘要份额不被单元抢占）；shadow 不预留不生成。
  // 摘要首次 LLM 调用前的任何退出（门禁失败/派发致命错误/数据异常）都必须经 Task 7
  // fix round 2 的安全路径释放该预挂号预留（同事务复位 summary_reserved，见末尾 catch）；
  // 进入共享解析器后由它恰好 settle 一次（summaryHandedOff 置位，绝不重复释放）。
  const summaryReservation = options.activate ? await reserveProductSummaryBudget(runId) : null;
  // B：恢复路径拿到的预留可能已结算（上一进程在摘要结算后崩溃）——已结算的摘要绝不重新
  // 生成（usage 无法二次入账），摘要阶段按 D10 降级；settled_unknown 等价 usage 未知
  // 硬阻断（停止派发 + 门禁 fail closed）。已结算预留不可释放，移交标志置位。
  const summaryAlreadySettled = summaryReservation != null && summaryReservation.status !== "reserved";
  let summaryHandedOff = summaryAlreadySettled;
  const preDispatchBudgetBlocked = orphanUsageUnknownBlocked || summaryReservation?.status === "settled_unknown";
  try {
    // ---- 调度：worker pool，每任务固定 reserve → claim ----
    const rowsBefore = await loadPersistedTaskRows(execute, runId);
    const eligible = manifest.tasks.filter((task) => !isReusableTerminal(rowsBefore.get(task.taskKey)));
    const reusedTerminal = manifest.tasks.length - eligible.length;
    const state: DispatchState = {
      stopDispatch: preDispatchBudgetBlocked,
      budgetBlocked: preDispatchBudgetBlocked,
      fatal: null,
      executed: 0,
      passInfos: [],
    };
    const leaseOwner = `inventory-${runId}-${randomUUID()}`;
    const queue = [...eligible];
    // related-reference：判定 prompt 的有效单元 key 目录（截断 150 防爆 prompt）
    const knownUnitKeys = manifest.units.map((unit) => unit.unitKey).slice(0, 150);

    // ---- execution batch（Task 8）：batch 模式按 ready plan set 路由，fallback 走单任务路径 ----
    const batchMode = behaviorAnalysisExecutionMode() === "batch";
    let batchWork: BatchWorkItem[] = [];
    let batchManifestHash = "";
    if (batchMode && eligible.length > 0) {
      batchManifestHash = sha256Utf8(JSON.stringify({ v: manifest.inventorySchemaVersion, after: manifest.afterSha, scope: manifest.scopeFingerprint }));
      // 预读并行化（回路修复 1）：2613 个任务的源码读取此前串行，占计划阶段数分钟
      const PLAN_READ_CONCURRENCY = 16;
      const planInputs: Array<import("./execution-batch/planner").PlanTaskInput> = [];
      let planCursor = 0;
      const planWorkers = Array.from({ length: Math.min(PLAN_READ_CONCURRENCY, eligible.length) }, async () => {
        for (;;) {
          const cursor = planCursor;
          planCursor += 1;
          const task = eligible[cursor];
          if (!task) return;
          const unit = unitsByKey.get(task.unitKey);
          if (!unit) continue;
          const sources = await loadBehaviorTaskSources(index, task, unit);
          const lineIndex = primaryLineIndexOf(sources);
          const primary = sources.find((source) => source.role === "primary") ?? sources[0]!;
          planInputs.push({
            task,
            isResidual: false,
            primaryPath: primary.path,
            primaryUtf8Bytes: sources.reduce((total, source) => total + Buffer.byteLength(source.content, "utf8"), 0),
            hasBlankFragment: task.anchorFragments.some((fragment) => fragmentIsBlank(fragment, lineIndex)),
            supportedShape: true,
          });
        }
      });
      await Promise.all(planWorkers);
      const allocation = planBehaviorExecutionBatches({ manifestHash: batchManifestHash, tasks: planInputs });
      await publishBehaviorBatchPlanSet(execute, { runId, manifestHash: batchManifestHash, manifestTaskKeys: eligible.map((task) => task.taskKey), allocation });
      const routed = routeBatchWorkItems(eligible, allocation);
      batchWork = routed.batchWork;
      queue.length = 0;
      queue.push(...routed.fallbackTasks);
      // 恢复：先消费此前崩溃遗留的已持久化响应（零新模型调用或只补 judge）
      await recoverInventoryBatchAttempts({
        runId,
        accountId: input.run.accountId ?? null,
        manifestHash: batchManifestHash,
        chargeComponent: options.activate ? "main" : "platform_shadow",
        leaseOwner,
        leaseDurationMs,
        maxAttempts,
        loadSources: (task) => loadBehaviorTaskSources(index, task, unitsByKey.get(task.unitKey)!),
        tasks: eligible,
        knownFeatureNames: input.knownFeatureNames,
        knownUnitKeys,
        outputLanguage,
      });
    }

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
        // Task 15 遥测口径：本 run 实际发起提取尝试的任务（含发起后硬失败的）即计 executed；
        // 首个 attempt 发起时计数，重试不重复计（attempt 级会计在 attemptsTotal / LLM 回执）。
        if (attemptsThisRun === 1) state.executed += 1;
        let result: BehaviorTaskExtractionResult;
        // F：执行窗口（源加载 + 复述/判定 + 复核）可能远超租约时长——周期续约（lease/3），
        // 续约失败（租约丢失/被抢占）视为硬失败：中止本 attempt，绝不提交。
        let leaseError: unknown = null;
        const heartbeat = setInterval(() => {
          void renewBehaviorTaskLease({
            execute,
            runId,
            taskKey: task.taskKey,
            attemptId: claimed.attemptId,
            leaseOwner,
            leaseDurationMs,
          }).catch((error: unknown) => {
            leaseError ??= error;
          });
        }, Math.max(1, Math.floor(leaseDurationMs / 3)));
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
          const extractInput = {
            task,
            sources,
            billing,
            knownFeatureNames: input.knownFeatureNames,
            knownUnitKeys,
            outputLanguage,
            label: `inventory/${runId}/${task.taskKey.slice(0, 48)}`,
          };
          result = await extractBehaviorTask(extractInput);
          // I：unresolved 且仍有未决回执（归因洞除外）且本 attempt 之后还有重试预算时，
          // 同 attempt 内做一次语义复核（单判定调用）。复核趟与首趟共用同一预留：
          // settle 按实际回执入账，超出预留量不截断（仅受 run 上限约束）。
          if (
            result.outcome === "unresolved" &&
            result.anchorReceipts.some((receipt) => receipt.disposition === "unresolved") &&
            claimed.attempts < maxAttempts &&
            !state.stopDispatch
          ) {
            result = await extractBehaviorTask({ ...extractInput, repair: { previous: result } });
          }
          // 执行期间租约曾丢失：结果不可信（提交谓词大概率也不再匹配），按硬失败处理
          if (leaseError != null) throw leaseError;
        } catch (error) {
          // 硬失败（网关/超时/源不可读/租约丢失）：记 failed（消耗 attempt），settle 后按预算重试
          await markBehaviorTaskFailure({ execute, runId, taskKey: task.taskKey, attemptId: claimed.attemptId, leaseOwner, error: errorMessage(error) });
          await safeSettle(reservation.reservationId);
          if (claimed.attempts < maxAttempts && !state.stopDispatch) continue;
          state.passInfos.push({ retries: attemptsThisRun - 1, sanitize: zeroSanitize(true) });
          return;
        } finally {
          clearInterval(heartbeat);
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

    // ---- batch 计划执行（聚合前落库，保证 rowsAfter 读到 batch 提交结果；激活等待全部 repair 完毕）----
    // 与 fallback worker pool 同档并发：attempt 之间彼此独立（各自 reservation/attempt/claim），
    // 并发安全由 task claim 原子性 + member 唯一约束 + processing fencing 保证。
    let batchCursor = 0;
    const runBatchWork = async (work: BatchWorkItem): Promise<void> => {
      try {
        await runInventoryBatchAttempt({
          runId,
          accountId: input.run.accountId ?? null,
          batchKey: work.plan.batchKey,
          manifestHash: batchManifestHash,
          plan: work.plan,
          tasks: work.tasks,
          loadSources: (task) => loadBehaviorTaskSources(index, task, unitsByKey.get(task.unitKey)!),
          leaseOwner,
          leaseDurationMs,
          maxAttempts,
          chargeComponent: options.activate ? "main" : "platform_shadow",
          knownFeatureNames: input.knownFeatureNames,
          knownUnitKeys,
          outputLanguage,
        });
      } catch (error) {
        // 派发结果未知/硬失败：任务保持可恢复状态交由恢复路径；不阻断聚合
        console.warn("[full-analysis] batch attempt ended with error", { runId, batchKey: work.plan.batchKey, error: errorMessage(error) });
      }
    };
    const batchWorkers = Array.from({ length: Math.min(concurrency, Math.max(batchWork.length, 1)) }, async () => {
      while (!state.stopDispatch && state.fatal == null) {
        const work = batchWork[batchCursor];
        batchCursor += 1;
        if (!work) return;
        await runBatchWork(work);
      }
    });
    await Promise.all(batchWorkers);

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
      const { assignments, refAliases } = assignLocalScenarioKeysWithAliases({ unit, tasks: states });
      assignmentsByUnit.set(unit.unitKey, assignments);
      for (const assignment of assignments) {
        localKeyByTaskRef.set(`${assignment.taskKey}\n${assignment.reference}`, assignment.localScenarioKey);
      }
      // 去重候选别名：直查映射已覆盖的键不覆盖（直查优先），只补行为等价丢弃候选的解析
      for (const [aliasKey, localScenarioKey] of refAliases) {
        if (!localKeyByTaskRef.has(aliasKey)) localKeyByTaskRef.set(aliasKey, localScenarioKey);
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

    // ---- 覆盖（门禁口径）：eligibleRanges 取 manifest 持久化诊断（K：实现面区间由清单
    // 生成期的独立枚举计算并随 manifest 受 hash 保护，恢复与首跑同口径；绝不从单元
    // 主区间反推——那会让「单元认领即覆盖」成为恒真式） ----
    const eligibleRanges = manifest.diagnostics?.eligibleRanges ?? [];
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
      // G：合并检查不再硬编码通过——reviewed 审计候选截断（changesTruncated>0）意味着
      // 合并面静默丢条目，激活门禁必须 fail closed（去重/折叠是正常确定性合并，不计异常）。
      existingMergeChecksPassed: merged.stats.changesTruncated === 0,
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
      if (summaryAlreadySettled) {
        // B：恢复路径摘要预留已结算——绝不重新生成（usage 无法二次入账）也绝不重复
        // settle/release；按 D10 降级：语言一致沿用旧简介，否则 unavailable。
        if (previous != null && previous.language === outputLanguage) {
          product = { description: previous.description, evidence: previous.evidence };
          productDescriptionStatus = "preserved";
        } else {
          productDescriptionStatus = "unavailable";
        }
      } else {
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
    const { diffTotalPaths, diffSelectedPaths, diffOmittedPaths } = diffPathCoverage(input.change.files, unitPaths);
    const coverage: AnalysisCoverageReceipt = {
      implFilesAssembled: unitPaths.length,
      implFilesTotal: unitPaths.length,
      implBytesAssembled: implBytesTotal,
      implBytesTotal,
      coverageRatio: 1,
      partitionsUsed: terminalTaskCount,
      partitionsCapped: false,
      diffTotalPaths,
      diffSelectedPaths,
      diffOmittedPaths,
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
      // D：清单生成诊断暴露（随 manifest 持久化，恢复路径同口径，无需重扫）
      detectorUnsupportedPaths: manifest.diagnostics?.detectorUnsupported ?? [],
      detectorParseFailurePaths: manifest.diagnostics?.detectorParseFailure ?? [],
      dynamicRegistrationFallbackPaths: manifest.diagnostics?.dynamicRegistrationFallback ?? [],
      unreadablePaths: manifest.diagnostics?.unreadablePaths ?? [],
      primaryRangesCoveredLines: inventoryCoverage.primaryCoverage.uniqueLinesCovered,
      primaryRangesOmittedLines: inventoryCoverage.primaryCoverage.uniqueLinesOmitted,
      anchorRangesCoveredLines: inventoryCoverage.anchorCoverage.uniqueLinesCovered,
      anchorRangesOmittedLines: inventoryCoverage.anchorCoverage.uniqueLinesOmitted,
      tasksTotal: manifest.tasks.length,
      tasksReusedTerminal: reusedTerminal,
      tasksExecuted: state.executed,
      // Task 15：pending 按持久化行 status='pending' 的字面计数——failed/unresolved/running
      // 都不是 pending（旧口径 total − reused − executed 会把发起后失败的任务误报为 pending）。
      tasksPending: taskRows.filter((row) => row.status === "pending").length,
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
        // 与 inventory 详情同口径（Task 15）：字面 status='pending' 行计数
        pending: taskRows.filter((row) => row.status === "pending").length,
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
