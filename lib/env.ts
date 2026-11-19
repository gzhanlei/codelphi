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
