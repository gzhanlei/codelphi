export function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

export function chandlerBaseUrl() {
  return (process.env.CHANDLER_BASE_URL ?? "https://api.chandler.work").replace(/\/$/, "");
}

/** Cloudflare Turnstile site key（公开值，注册/登录页 widget 用）。siteverify 由 Chandler 服务端执行，
 *  CoDelphi 只做「页面采集 + 透传 cf_turnstile_response」，不持有 secret、不重复消费 token。 */
export function turnstileSiteKey() {
  return (process.env.TURNSTILE_SITE_KEY ?? "").trim();
}

export function allowedEmails() {
  return new Set(
    (process.env.AUTH_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function publicDemoSlugs() {
  return new Set(
    (process.env.PUBLIC_DEMO_SLUGS ?? "")
      .split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function prPreviewEnabled() {
  return process.env.PR_PREVIEW_ENABLED !== "false";
}

export function incrementalShadowEnabled() {
  return process.env.INCREMENTAL_SHADOW === "true";
}

/** AI 上下文窗口预算覆盖（字节）。一次性定向重分析用：塌缩恢复需要比日常 160KB 更大的窗口。 */
export function analysisAiContextBudgetOverride() {
  const raw = Number(process.env.ANALYSIS_AI_CONTEXT_BUDGET_BYTES ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** W2 收敛式全量（2026-11-19 立项）：多趟提取的轮数上限。默认 1=现行为（单趟采样）；
 * 调高后按边际产出收敛（新增锚定场景 < ε 停止），趟数→成本如实放大。clamp [1,10] 防误配。 */
export function analysisConvergenceRounds(): number {
  const raw = Number(process.env.ANALYSIS_CONVERGENCE_ROUNDS ?? "");
  if (!Number.isInteger(raw) || raw < 1) return 1;
  return Math.min(raw, 10);
}

/** W2 收敛阈值 ε：一轮新增锚定场景少于该值视为收敛。默认 5。 */
export function analysisConvergenceEpsilon(): number {
  const raw = Number(process.env.ANALYSIS_CONVERGENCE_EPSILON ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : 5;
}

/** W2 收敛判定：轮数未到上限且边际新增锚定场景 ≥ ε（默认 5 条）时再跑一轮。 */
export function shouldRunAnotherConvergenceRound(input: { roundsRun: number; scenarioCount: number; lastCount: number; maxRounds: number; epsilon: number }): boolean {
  if (input.roundsRun >= input.maxRounds) return false;
  return input.scenarioCount - input.lastCount >= input.epsilon;
}

/** 分区趟数上限（成本闸门）：默认无界（保持按仓库穷尽的覆盖语义）；配置后命中即截断并披露。 */
export function analysisMaxPartitions(): number | null {
  const raw = Number(process.env.ANALYSIS_MAX_PARTITIONS ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

export function behavioralEnumerationEnabled() {
  return process.env.BEHAVIORAL_ENUMERATION !== "false";
}

export function behavioralEnumerationGroupSize() {
  const raw = Number(process.env.BEHAVIORAL_ENUM_GROUP_SIZE ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : 6;
}

export function behavioralEnumerationMaxGroups() {
  const raw = Number(process.env.BEHAVIORAL_ENUM_MAX_GROUPS ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : 8;
}

/** 全量分析模式：legacy（现状分区/收敛）| inventory_shadow（跑库存编排但不激活）| inventory（库存编排激活）。
 * 默认与垃圾值一律回退 legacy——新模式必须显式开启。 */
export function fullAnalysisMode(): "legacy" | "inventory_shadow" | "inventory" {
  const raw = (process.env.FULL_ANALYSIS_MODE ?? "").trim();
  if (raw === "inventory" || raw === "inventory_shadow") return raw;
  return "legacy";
}

/** 行为清单执行模式（Task 8）：task=既有单任务双步路径；batch=execution batch。
 *  默认/垃圾值回退 task；batch 只对新 run 生效，不在已有 run 中途切换（§17）。 */
export function behaviorAnalysisExecutionMode(): "task" | "batch" {
  const raw = (process.env.ANALYSIS_BEHAVIOR_EXECUTION_MODE ?? "").trim();
  if (raw === "batch") return "batch";
  return "task";
}

/** 库存编排的单元并发度。默认 4，clamp [1,16]，垃圾值回退默认。 */
export function behaviorAnalysisConcurrency(): number {
  const raw = Number(process.env.ANALYSIS_BEHAVIOR_CONCURRENCY ?? "");
  if (!Number.isInteger(raw) || raw < 1) return 4;
  return Math.min(raw, 16);
}

/** 库存编排的本次运行预算上限。缺省/非正值 = 无上限（undefined，绝不用 0 表无上限）。 */
export function behaviorAnalysisBudget(): {
  maxLlmCalls?: number;
  maxTotalTokens?: number;
  maxCostAmount?: number;
  currency: string;
} {
  const positiveNumber = (name: string) => {
    const raw = Number(process.env[name] ?? "");
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  };
  return {
    maxLlmCalls: positiveNumber("ANALYSIS_BEHAVIOR_MAX_LLM_CALLS"),
    maxTotalTokens: positiveNumber("ANALYSIS_BEHAVIOR_MAX_TOTAL_TOKENS"),
    maxCostAmount: positiveNumber("ANALYSIS_BEHAVIOR_MAX_COST_AMOUNT"),
    currency: (process.env.ANALYSIS_BEHAVIOR_COST_CURRENCY ?? "").trim() || "CNY",
  };
}
