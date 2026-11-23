import {
  evaluateBehaviorNonInferiority,
  type BenchmarkVerdict,
  type RepoComparison,
} from "./behavior-benchmark";
import type { PipelineTaskUsage, PipelineUsage } from "./pipeline-usage";

export type { PipelineTaskUsage, PipelineUsage } from "./pipeline-usage";

export interface PipelineExperimentIdentity {
  repo: string;
  beforeSha: string | null;
  afterSha: string;
  benchmarkTruthVersion: string;
  model: string;
  modelConfigHash: string;
  outputLanguage: "zh-CN" | "en";
  budgetConfigHash: string;
  pricingConfigHash: string;
  cacheCondition: string;
  legacyResult: { runId: number; outputHash: string };
  baselineCodeSha: string;
  candidateCodeSha: string;
  describePromptHash: { baseline: string; candidate: string };
  judgePromptBaselineHash: { baseline: string; candidate: string };
  repairPromptBaselineHash: { baseline: string; candidate: string };
  promptDelta: "batch_execution_only";
}

export interface PipelineCost {
  llmCalls: number;
  totalTokens: number;
  costAmount: number;
  currency: string;
  pricingConfigHash: string;
  durationMs?: number;
}

export interface PipelineOutputFacts {
  featureCount: number;
  scenarioCount: number;
  duplicateClusters: number;
  factInterpretationErrors: number;
  activationPassed: boolean;
}

export interface ImprovementRepoInput {
  identity: PipelineExperimentIdentity;
  baseline: RepoComparison;
  candidate: RepoComparison;
  baselineCost: PipelineCost;
  candidateCost: PipelineCost;
  baselineUsage: PipelineUsage;
  candidateUsage: PipelineUsage;
  baselineLegacyOutputHash: string;
  candidateLegacyOutputHash: string;
  baselineBenchmarkTruthVersion: string;
  candidateBenchmarkTruthVersion: string;
  baselineOutput: PipelineOutputFacts;
  candidateOutput: PipelineOutputFacts;
}

export interface PipelineImprovementVerdict {
  status: "passed" | "failed" | "inconclusive";
  adoptionReady: boolean;
  reasons: string[];
  candidateQuality: BenchmarkVerdict;
}

const MAX_LLM_CALL_RATIO = 0.35;
const MAX_TOKEN_RATIO = 0.60;
const MAX_COST_RATIO = 0.60;
const MAX_FEATURE_RATIO = 1.05;
const MAX_SCENARIO_RATIO = 1.10;

function sameBehaviorPairs(baseline: RepoComparison, candidate: RepoComparison): boolean {
  if (baseline.pairs.length !== candidate.pairs.length) return false;
  const candidateById = new Map(candidate.pairs.map((pair) => [pair.behaviorId, pair]));
  return baseline.pairs.every((pair) => candidateById.get(pair.behaviorId)?.legacyHit === pair.legacyHit);
}

function tasksByKey(usage: PipelineUsage): Map<string, PipelineTaskUsage> {
  return new Map(usage.tasks.map((task) => [task.taskKey, task]));
}

function sameTaskKeys(baseline: PipelineUsage, candidate: PipelineUsage): boolean {
  const left = tasksByKey(baseline);
  const right = tasksByKey(candidate);
  return left.size === right.size && [...left.keys()].every((key) => right.has(key));
}

function costComparable(cost: PipelineCost): boolean {
  return Number.isFinite(cost.llmCalls) && cost.llmCalls >= 0
    && Number.isFinite(cost.totalTokens) && cost.totalTokens >= 0
    && Number.isFinite(cost.costAmount) && cost.costAmount >= 0
    && cost.currency.length > 0 && cost.pricingConfigHash.length > 0;
}

export function evaluatePipelineImprovement(
  repos: readonly ImprovementRepoInput[],
): PipelineImprovementVerdict {
  const failures: string[] = [];
  const inconclusive: string[] = [];
  if (repos.length === 0) {
    return {
      status: "inconclusive",
      adoptionReady: false,
      reasons: ["empty experiment set"],
      candidateQuality: evaluateBehaviorNonInferiority([]),
    };
  }

  for (const repo of repos) {
    const { identity, baseline, candidate, baselineCost, candidateCost } = repo;
    if (baseline.repo !== identity.repo || candidate.repo !== identity.repo) {
      inconclusive.push(`${identity.repo}: repo 与实验身份不一致`);
    }
    if (!sameBehaviorPairs(baseline, candidate)) {
      inconclusive.push(`${identity.repo}: behaviorId 集合或 legacyHit 不一致`);
    }
    if (repo.baselineLegacyOutputHash !== identity.legacyResult.outputHash
      || repo.candidateLegacyOutputHash !== identity.legacyResult.outputHash) {
      inconclusive.push(`${identity.repo}: 两份对照未复用同一 legacy 输出`);
    }
    if (repo.baselineBenchmarkTruthVersion !== identity.benchmarkTruthVersion
      || repo.candidateBenchmarkTruthVersion !== identity.benchmarkTruthVersion) {
      inconclusive.push(`${identity.repo}: 人工真值版本不一致`);
    }
    if (identity.promptDelta !== "batch_execution_only") {
      inconclusive.push(`${identity.repo}: 未声明允许的 Prompt 差异`);
    }
    if (identity.repairPromptBaselineHash.baseline !== identity.repairPromptBaselineHash.candidate) {
      inconclusive.push(`${identity.repo}: repair Prompt 基线不一致`);
    }

    const baselineHits = baseline.pairs.filter((pair) => pair.inventoryHit).length;
    const candidateHits = candidate.pairs.filter((pair) => pair.inventoryHit).length;
    if (candidateHits < baselineHits) failures.push(`${identity.repo}: 候选召回下降 ${baselineHits} → ${candidateHits}`);
    if (repo.candidateOutput.featureCount > repo.baselineOutput.featureCount * MAX_FEATURE_RATIO) {
      failures.push(`${identity.repo}: 功能数超过 1.05 倍碎片化上限`);
    }
    if (repo.candidateOutput.scenarioCount > repo.baselineOutput.scenarioCount * MAX_SCENARIO_RATIO) {
      failures.push(`${identity.repo}: 场景数超过 1.10 倍碎片化上限`);
    }
    if (repo.candidateOutput.duplicateClusters > repo.baselineOutput.duplicateClusters) {
      failures.push(`${identity.repo}: 重复功能簇增加`);
    }
    if (repo.candidateOutput.factInterpretationErrors > repo.baselineOutput.factInterpretationErrors) {
      failures.push(`${identity.repo}: 事实解释错误增加`);
    }

    if (!costComparable(baselineCost) || !costComparable(candidateCost)) {
      inconclusive.push(`${identity.repo}: 成本回执缺失或非法`);
    } else {
      if (baselineCost.currency !== candidateCost.currency
        || baselineCost.pricingConfigHash !== candidateCost.pricingConfigHash
        || identity.pricingConfigHash !== candidateCost.pricingConfigHash) {
        inconclusive.push(`${identity.repo}: 币种或定价不可比`);
      }
      if (candidateCost.llmCalls > baselineCost.llmCalls * MAX_LLM_CALL_RATIO) failures.push(`${identity.repo}: 总 LLM 调用数超过 0.35 倍上限`);
      if (candidateCost.totalTokens > baselineCost.totalTokens * MAX_TOKEN_RATIO) failures.push(`${identity.repo}: token 超过 0.60 倍上限`);
      if (candidateCost.costAmount > baselineCost.costAmount * MAX_COST_RATIO) failures.push(`${identity.repo}: 实际成本超过 0.60 倍上限`);
    }

    if (!sameTaskKeys(repo.baselineUsage, repo.candidateUsage)) {
      inconclusive.push(`${identity.repo}: taskKey 集合不可匹配`);
    } else {
      const candidateTasks = tasksByKey(repo.candidateUsage);
      for (const baselineTask of repo.baselineUsage.tasks) {
        const candidateTask = candidateTasks.get(baselineTask.taskKey)!;
        if (candidateTask.total > baselineTask.total
          || candidateTask.describe > baselineTask.describe
          || candidateTask.judge > baselineTask.judge
          || candidateTask.semanticRepair > baselineTask.semanticRepair) {
          failures.push(`${identity.repo}/${baselineTask.taskKey}: task/stage 调用增加`);
        }
        if (candidateTask.reusedTerminal && candidateTask.total > 0) {
          failures.push(`${identity.repo}/${baselineTask.taskKey}: 成功恢复任务产生新调用`);
        }
      }
    }
  }
  const candidateQuality = evaluateBehaviorNonInferiority(repos.map((repo) => repo.candidate));
  if (candidateQuality.status === "failed") failures.push(...candidateQuality.reasons);
  else if (candidateQuality.status === "inconclusive") inconclusive.push(...candidateQuality.reasons);

  const adoptionReady = failures.length === 0 && inconclusive.length === 0
    && repos.every((repo) => repo.candidateOutput.activationPassed);
  if (failures.length > 0) {
    return { status: "failed", adoptionReady: false, reasons: [...failures, ...inconclusive], candidateQuality };
  }
  if (inconclusive.length > 0) {
    return { status: "inconclusive", adoptionReady: false, reasons: inconclusive, candidateQuality };
  }
  return { status: "passed", adoptionReady, reasons: [], candidateQuality };
}
