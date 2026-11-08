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
