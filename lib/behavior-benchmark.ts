/**
 * Task 15 · 配对行为 benchmark 的纯统计层（设计 §9.5，冻结协议见
 * docs/benchmark/frozen/behavior-inventory-v1.md）。不读库、不调 AI、不依赖
 * FULL_ANALYSIS_MODE——只接受「冻结人工行为 × 两条路径的命中判定」配对数据。
 *
 * 口径（与冻结协议一致，改动任一处必须同步另一处）：
 *  - 基本单位是冻结人工行为，不是任一系统生成的场景数；一个场景可命中多个行为，
 *    多个场景也可共同命中一个行为（拆分/合并单独记录，不进配对）。
 *  - 召回差值 Delta = Recall_inventory − Recall_legacy，对同一批行为逐条配对；
 *    仅出现在一条路径的输出行为单独列出，绝不人为构造配对。
 *  - 差值区间用 Newcombe 配对差值区间（method 10：两条 Wilson 区间 square-and-add），
 *    禁止用两个独立 Wilson 区间代替差值检验；各路径自身的比例（召回/误报/证据）
 *    保留各自的 Wilson 区间，仅作不确定性描述。
 *  - 误报与证据有效率的分母 = 各路径实际评估的输出行为数，两路径分母互相独立。
 */

/** 非劣效界：逐仓要求 LowerCI(Delta) 严格大于该值（设计 §9.5）。 */
export const NON_INFERIORITY_MARGIN = -0.03;
/** 每仓冻结人工行为的初始最低样本数；达到下限不等于统计功效充分。 */
export const MIN_PAIRED_BEHAVIOR_SAMPLES = 30;
/** 宏平均误报率上升上限（辅助门禁，不替代配对召回门禁）。 */
export const MAX_MACRO_FALSE_POSITIVE_RISE = 0.03;
/** 宏平均证据有效率下降上限（辅助门禁，不替代配对召回门禁）。 */
export const MAX_MACRO_EVIDENCE_SUPPORT_DROP = 0.02;

export interface ConfidenceInterval {
  lower: number;
  upper: number;
  confidence: number;
}

/** 一条冻结人工行为在两条路径上的命中判定（配对的基本单元）。 */
export interface PairedBehaviorOutcome {
  behaviorId: string;
  /** 新路径（inventory 编排）是否命中该行为。 */
  inventoryHit: boolean;
  /** 旧路径（legacy 分区/收敛）是否命中该行为。 */
  legacyHit: boolean;
}

/** 某条路径上的一类二元会计（召回/误报/证据支持），分母为该路径自身的会计总体。 */
export interface PathProportionInput {
  successes: number;
  total: number;
}

/** 误报会计：分母 = 该路径实际评估的输出行为数（两路径分母互相独立，unmatched 不配对）。 */
export interface FalsePositiveAccounting {
  falsePositives: number;
  evaluatedOutputs: number;
}

/** 证据有效率会计：分母 = 该路径实际评估的输出行为数。 */
export interface EvidenceSupportAccounting {
  supported: number;
  evaluatedOutputs: number;
}

export interface ProportionSummary extends PathProportionInput {
  proportion: number;
  interval: ConfidenceInterval;
}

/** 单仓对照输入：配对召回 + 误报/证据辅助会计 + 过程门禁声明。 */
export interface RepoComparison {
  repo: string;
  pairs: readonly PairedBehaviorOutcome[];
  /**
   * 过程门禁（单元清单/区间/锚点/激活门禁，设计 §9.5）是否全部通过。false → 整体 failed，
   * 即使配对统计 inconclusive 也不例外——benchmark 不能抵消过程缺陷。
   */
  processGatesPassed: boolean;
  /** 误报/证据会计缺失（fail closed）：该仓统计照算，但整体结论 inconclusive，绝不放行。 */
  falsePositives?: { legacy: FalsePositiveAccounting; inventory: FalsePositiveAccounting };
  evidenceSupport?: { legacy: EvidenceSupportAccounting; inventory: EvidenceSupportAccounting };
}

export type RepoVerdictStatus = "non_inferior" | "inferior" | "inconclusive";

export interface RepoVerdict {
  repo: string;
  sampleSize: number;
  legacyRecall: ProportionSummary | null;
  inventoryRecall: ProportionSummary | null;
  /** 配对差值点估计；样本为空时为 null。 */
  delta: number | null;
  deltaInterval: ConfidenceInterval | null;
  status: RepoVerdictStatus;
  reasons: string[];
  falsePositives?: { legacy: ProportionSummary; inventory: ProportionSummary; rise: number };
  evidenceSupport?: { legacy: ProportionSummary; inventory: ProportionSummary; drop: number };
}

export interface BenchmarkVerdict {
  status: "passed" | "failed" | "inconclusive";
  repos: RepoVerdict[];
  /** 宏平均差值点估计（跨仓简单平均，只作描述，不伪造独立比例区间）。 */
  macroAverageDelta: number | null;
  macroFalsePositiveRise: number | null;
  macroEvidenceSupportDrop: number | null;
  margin: number;
  minSamples: number;
  reasons: string[];
}

/**
 * 标准正态分布逆 CDF（Acklam 有理逼近，无依赖）。精度 ~1e-9，
 * 对 0.90/0.95/0.99 等常规置信度足够（95% → z=1.959963984540054）。
 */
function inverseNormalCdf(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`inverseNormalCdf requires 0 < p < 1, got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pLow) return -inverseNormalCdf(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function zForConfidence(confidence: number): number {
  if (!(confidence > 0 && confidence < 1)) throw new Error(`confidence must be in (0, 1), got ${confidence}`);
  return inverseNormalCdf(1 - (1 - confidence) / 2);
}

/**
 * 单比例的 Wilson score 区间（描述某条路径自身召回/误报率的不确定性）。
 * 只用于「各路径自身比例」；两路径差值的检验必须用 Newcombe 配对区间。
 */
export function wilsonProportionInterval(successes: number, total: number, confidence = 0.95): ConfidenceInterval {
  if (!Number.isInteger(total) || total <= 0) throw new Error(`total must be a positive integer, got ${total}`);
  if (!Number.isInteger(successes) || successes < 0 || successes > total) {
    throw new Error(`successes must be an integer in [0, total], got ${successes}/${total}`);
  }
  const z = zForConfidence(confidence);
  const z2 = z * z;
  const p = successes / total;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return { lower: Math.max(0, center - halfWidth), upper: Math.min(1, center + halfWidth), confidence };
}

export function summarizeProportion(input: PathProportionInput, confidence = 0.95): ProportionSummary {
  return { ...input, proportion: input.successes / input.total, interval: wilsonProportionInterval(input.successes, input.total, confidence) };
}

function assertPairsNonEmpty(pairs: readonly PairedBehaviorOutcome[]): void {
  if (pairs.length === 0) throw new Error("paired statistics require at least one pair (empty pair set)");
}

/** 配对召回差值点估计：Delta = (ΣinventoryHit − ΣlegacyHit) / n，单位是冻结人工行为。 */
export function pairedRecallDelta(pairs: readonly PairedBehaviorOutcome[]): number {
  assertPairsNonEmpty(pairs);
  let inventoryHits = 0;
  let legacyHits = 0;
  for (const pair of pairs) {
    if (pair.inventoryHit) inventoryHits += 1;
    if (pair.legacyHit) legacyHits += 1;
  }
  return (inventoryHits - legacyHits) / pairs.length;
}

/**
 * 配对二元比例差值的 Newcombe 区间（method 10，square-and-add，无连续性校正）：
 * 对两路径各自的 Wilson 区间 (l1,u1) / (l2,u2)，
 *   Lower = Delta − √((p1−l1)² + (u2−p2)²)，Upper = Delta + √((p2−l2)² + (u1−p1)²)。
 * 配对数据绝不允许改用「两个独立 Wilson 区间是否重叠 / 朴素差值区间 [l1−u2, u1−l2]」
 * 代替——同一批数据下两者可以给出相反的门槛结论。
 */
export function newcombePairedInterval(pairs: readonly PairedBehaviorOutcome[], confidence = 0.95): ConfidenceInterval {
  assertPairsNonEmpty(pairs);
  const n = pairs.length;
  const inventoryHits = pairs.filter((pair) => pair.inventoryHit).length;
  const legacyHits = pairs.filter((pair) => pair.legacyHit).length;
  const p1 = inventoryHits / n;
  const p2 = legacyHits / n;
  const inventory = wilsonProportionInterval(inventoryHits, n, confidence);
  const legacy = wilsonProportionInterval(legacyHits, n, confidence);
  const delta = p1 - p2;
  return {
    lower: delta - Math.sqrt((p1 - inventory.lower) ** 2 + (legacy.upper - p2) ** 2),
    upper: delta + Math.sqrt((p2 - legacy.lower) ** 2 + (inventory.upper - p1) ** 2),
    confidence,
  };
}

function evaluateRepo(comparison: RepoComparison, confidence: number): RepoVerdict {
  const sampleSize = comparison.pairs.length;
  const reasons: string[] = [];
  const verdict: RepoVerdict = {
    repo: comparison.repo,
    sampleSize,
    legacyRecall: sampleSize > 0 ? summarizeProportion({ successes: comparison.pairs.filter((pair) => pair.legacyHit).length, total: sampleSize }, confidence) : null,
    inventoryRecall: sampleSize > 0 ? summarizeProportion({ successes: comparison.pairs.filter((pair) => pair.inventoryHit).length, total: sampleSize }, confidence) : null,
    delta: sampleSize > 0 ? pairedRecallDelta(comparison.pairs) : null,
    deltaInterval: sampleSize > 0 ? newcombePairedInterval(comparison.pairs, confidence) : null,
    status: "inconclusive",
    reasons,
  };
  if (comparison.falsePositives) {
    const legacy = summarizeProportion({ successes: comparison.falsePositives.legacy.falsePositives, total: comparison.falsePositives.legacy.evaluatedOutputs }, confidence);
    const inventory = summarizeProportion({ successes: comparison.falsePositives.inventory.falsePositives, total: comparison.falsePositives.inventory.evaluatedOutputs }, confidence);
    verdict.falsePositives = { legacy, inventory, rise: inventory.proportion - legacy.proportion };
  }
  if (comparison.evidenceSupport) {
    const legacy = summarizeProportion({ successes: comparison.evidenceSupport.legacy.supported, total: comparison.evidenceSupport.legacy.evaluatedOutputs }, confidence);
    const inventory = summarizeProportion({ successes: comparison.evidenceSupport.inventory.supported, total: comparison.evidenceSupport.inventory.evaluatedOutputs }, confidence);
    verdict.evidenceSupport = { legacy, inventory, drop: legacy.proportion - inventory.proportion };
  }

  if (sampleSize < MIN_PAIRED_BEHAVIOR_SAMPLES) {
    reasons.push(`样本 ${sampleSize} 条低于初始下限 ${MIN_PAIRED_BEHAVIOR_SAMPLES}：达到下限也不等于功效充分，判 inconclusive`);
    return verdict;
  }
  const interval = verdict.deltaInterval as ConfidenceInterval;
  if (interval.lower > NON_INFERIORITY_MARGIN) {
    verdict.status = "non_inferior";
  } else if (interval.upper < NON_INFERIORITY_MARGIN) {
    verdict.status = "inferior";
    reasons.push(`配对差值区间 [${interval.lower.toFixed(4)}, ${interval.upper.toFixed(4)}] 整体低于非劣效界 ${NON_INFERIORITY_MARGIN}`);
  } else {
    reasons.push(`配对差值区间 [${interval.lower.toFixed(4)}, ${interval.upper.toFixed(4)}] 跨过非劣效界 ${NON_INFERIORITY_MARGIN}：无法判定非劣效（区间宽 = 功效不足），判 inconclusive`);
  }
  return verdict;
}

/**
 * 逐仓非劣效评估 + 宏平均汇总。判定顺序（fail closed，Task 15 fix）：
 *   任一仓过程门禁 false/missing → failed（即使统计 inconclusive 也不例外）；
 *   任一仓 inferior → failed；
 *   任一仓缺误报/证据会计 → inconclusive（缺失门禁输入绝不静默放行）；
 *   否则任一仓统计 inconclusive（含样本不足）→ inconclusive；
 *   否则宏平均差值点估计低于 −0.03，或宏平均误报上升 / 证据下降超预算 → failed；
 *   全部通过 → passed。
 * 误报/证据为辅助门禁（分母 = 各路径实际评估的输出行为数），不替代配对召回门禁；
 * 只有全部仓都提供对应会计时才计算宏平均，否则为 null。
 */
export function evaluateBehaviorNonInferiority(input: readonly RepoComparison[], options?: { confidence?: number }): BenchmarkVerdict {
  const confidence = options?.confidence ?? 0.95;
  const reasons: string[] = [];
  if (input.length === 0) {
    return { status: "inconclusive", repos: [], macroAverageDelta: null, macroFalsePositiveRise: null, macroEvidenceSupportDrop: null, margin: NON_INFERIORITY_MARGIN, minSamples: MIN_PAIRED_BEHAVIOR_SAMPLES, reasons: ["empty comparison set: no repos to evaluate"] };
  }
  const repos = input.map((comparison) => evaluateRepo(comparison, confidence));
  const deltas = repos.map((repo) => repo.delta).filter((delta): delta is number => delta != null);
  const macroAverageDelta = deltas.length > 0 ? deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length : null;
  const fpRises = repos.map((repo) => repo.falsePositives?.rise);
  const macroFalsePositiveRise = fpRises.every((rise): rise is number => rise != null) ? (fpRises as number[]).reduce((sum, rise) => sum + rise, 0) / fpRises.length : null;
  const evidenceDrops = repos.map((repo) => repo.evidenceSupport?.drop);
  const macroEvidenceSupportDrop = evidenceDrops.every((drop): drop is number => drop != null) ? (evidenceDrops as number[]).reduce((sum, drop) => sum + drop, 0) / evidenceDrops.length : null;

  let status: BenchmarkVerdict["status"];
  const gateFailed = input.filter((comparison) => comparison.processGatesPassed !== true);
  const inferior = repos.filter((repo) => repo.status === "inferior");
  const missingAccounting = repos.filter((repo) => repo.falsePositives == null || repo.evidenceSupport == null);
  const inconclusive = repos.filter((repo) => repo.status === "inconclusive");
  if (gateFailed.length > 0) {
    status = "failed";
    reasons.push(`仓库 ${gateFailed.map((comparison) => comparison.repo).join(", ")} 的过程门禁未通过（processGates）：benchmark 不能抵消过程缺陷`);
  } else if (inferior.length > 0) {
    status = "failed";
    reasons.push(`仓库 ${inferior.map((repo) => repo.repo).join(", ")} 的配对召回差值区间整体低于 ${NON_INFERIORITY_MARGIN}`);
  } else if (missingAccounting.length > 0) {
    status = "inconclusive";
    reasons.push(`仓库 ${missingAccounting.map((repo) => repo.repo).join(", ")} 缺少误报/证据会计（outputEvaluation）：fail closed，判 inconclusive 而非放行`);
  } else if (inconclusive.length > 0) {
    status = "inconclusive";
    reasons.push(`仓库 ${inconclusive.map((repo) => repo.repo).join(", ")} 无法判定非劣效（样本不足或区间跨过 ${NON_INFERIORITY_MARGIN}）`);
  } else if (macroAverageDelta != null && macroAverageDelta < NON_INFERIORITY_MARGIN) {
    status = "failed";
    reasons.push(`宏平均差值点估计 ${macroAverageDelta.toFixed(4)} 低于 ${NON_INFERIORITY_MARGIN}`);
  } else if (macroFalsePositiveRise != null && macroFalsePositiveRise > MAX_MACRO_FALSE_POSITIVE_RISE) {
    status = "failed";
    reasons.push(`宏平均误报率上升 ${(macroFalsePositiveRise * 100).toFixed(2)}pp 超过 ${MAX_MACRO_FALSE_POSITIVE_RISE * 100}pp（false-positive 辅助门禁）`);
  } else if (macroEvidenceSupportDrop != null && macroEvidenceSupportDrop > MAX_MACRO_EVIDENCE_SUPPORT_DROP) {
    status = "failed";
    reasons.push(`宏平均证据有效率下降 ${(macroEvidenceSupportDrop * 100).toFixed(2)}pp 超过 ${MAX_MACRO_EVIDENCE_SUPPORT_DROP * 100}pp（evidence 辅助门禁）`);
  } else {
    status = "passed";
  }
  return { status, repos, macroAverageDelta, macroFalsePositiveRise, macroEvidenceSupportDrop, margin: NON_INFERIORITY_MARGIN, minSamples: MIN_PAIRED_BEHAVIOR_SAMPLES, reasons };
}
