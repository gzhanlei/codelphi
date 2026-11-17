import type { analyzeWithAI, AnalysisResult } from "./ai";
import type { ChangeContext } from "./code-hosting";
import type { EvidenceSanitizeSummary } from "./completeness-ledger";
import type { AnalysisPartition } from "./remote-analysis";

/**
 * 证据清洗（替代整趟失败，2026-11-10 生产 run 185/186）：模型偶发引用「真实存在但本趟
 * 未读」的文件（相邻目录命名先验 / 公开仓库训练记忆），整趟作废会让其余分区的干净产出
 * 陪葬。只保留可溯源声明：不可溯源的场景 / 变化 / 功能整条剔除并留 warn 日志（红线不变：
 * 进规格的事实必须带可追溯证据）。清洗后为空 = 本趟无行为变化窗口，按既有语义接受
 * （空版本由坍缩护栏下游告警），不在此处抛错。
 */
export function sanitizeEvidence(result: AnalysisResult, sources: Set<string>, label: string): EvidenceSanitizeSummary {
  const hadCandidates = result.features.length > 0 || result.changes.length > 0;
  const droppedPaths = new Set<string>();
  const keep = (items: AnalysisResult["product"]["evidence"]) =>
    items.filter((item) => {
      if (sources.has(item.path)) return true;
      droppedPaths.add(item.path);
      return false;
    });
  result.product.evidence = keep(result.product.evidence);
  result.changes = result.changes.filter((change) => {
    change.evidence = keep(change.evidence);
    return change.evidence.length > 0;
  });
  const beforeScenarioCount = result.features.reduce((total, feature) => total + feature.scenarios.length, 0);
  result.features = result.features.filter((feature) => {
    feature.scenarios = feature.scenarios.filter((scenario) => {
      scenario.evidence = keep(scenario.evidence);
      return scenario.evidence.length > 0;
    });
    return feature.scenarios.length > 0;
  });
  const afterScenarioCount = result.features.reduce((total, feature) => total + feature.scenarios.length, 0);
  if (droppedPaths.size > 0) {
    console.warn("[analysis] dropped evidence-untraceable claims", { label, paths: [...droppedPaths], keptFeatures: result.features.length });
  }
  // W0-9 评审采纳（空结果三态）：候选全部被清洗 ≠ 无行为变化——独立告警，不得伪装成正常空结果
  const allCandidatesRejected = hadCandidates && result.features.length === 0 && result.changes.length === 0;
  if (allCandidatesRejected) {
    console.error("[analysis] all_candidates_rejected", { label, paths: [...droppedPaths] });
  }
  return {
    droppedClaims: beforeScenarioCount - afterScenarioCount,
    droppedScenarios: beforeScenarioCount - afterScenarioCount,
    droppedFeatures: beforeScenarioCount - afterScenarioCount > 0 ? result.features.length === 0 ? 1 : 0 : 0,
    allCandidatesRejected,
    empty: result.features.length === 0,
    keptClaims: afterScenarioCount,
  };
}

/** 分区局部证据允许集：AI 只能引用本分区窗口与 diff 文件（逐趟口径校验）。 */
export function evidenceAllowSet(partition: AnalysisPartition, change: ChangeContext) {
  return new Set([
    ...partition.slice.files.map((file) => file.path),
    ...change.files.map((file) => file.path),
  ]);
}

export interface ExtractPassOptions {
  sources: AnalysisPartition["sources"];
  change: ChangeContext;
  context: Parameters<typeof analyzeWithAI>[2];
  allowSet: Set<string>;
  label: string;
  /** Test/host injection point; production keeps the existing AI implementation. */
  analyze?: typeof analyzeWithAI;
  onRetry?: (error: Error) => void;
}

/**
 * 单趟提取失败重试一次：硬失败（解析 / 网络 / 网关）先重试一次而不是让整个 run 作废——
 * 重试调用的 LLM receipt 照常落库（成本如实记账），两次都失败才让 run 失败。证据路径
 * 清洗本身不再触发整趟作废（见 sanitizeEvidence；清洗后为空按无行为变化窗口接受）。
 */
export async function extractPassWithRetry(options: ExtractPassOptions): Promise<{ result: AnalysisResult; pass: { retries: number; sanitize: EvidenceSanitizeSummary } }> {
  const analyze = options.analyze ?? (async (...args: Parameters<typeof analyzeWithAI>) => (await import("./ai")).analyzeWithAI(...args));
  let retries = 0;
  let result: AnalysisResult;
  try {
    result = await analyze(options.sources, options.change, options.context);
  } catch (firstError) {
    options.onRetry?.(firstError instanceof Error ? firstError : new Error(String(firstError)));
    retries = 1;
    console.warn("[analysis] extraction pass failed; retrying once", {
      label: options.label,
      error: firstError instanceof Error ? firstError.message.slice(0, 200) : String(firstError),
    });
    result = await analyze(options.sources, options.change, options.context);
  }
  const sanitize = sanitizeEvidence(result, options.allowSet, options.label);
  return { result, pass: { retries, sanitize } };
}
