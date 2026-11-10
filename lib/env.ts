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

export interface PptPartnerConfig {
  /** PPTCreator Streamable HTTP MCP 端点。 */
  url: string;
  /** Partner API key（PPT_CREATOR 侧 PARTNER_API_KEYS 已配置的对端值）。 */
  key: string;
  orgId: string | null;
  memberId: string | null;
}

/** PPTCreator 服务（easymakeppt）partner 接入：PPT_PARTNER_KEY 未配置时返回 null（功能明确降级）。 */
export function pptPartnerConfig(): PptPartnerConfig | null {
  const key = process.env.PPT_PARTNER_KEY?.trim();
  if (!key) return null;
  return {
    url: (process.env.PPT_PARTNER_URL ?? "https://easymakeppt.com/mcp").replace(/\/$/, ""),
    key,
    orgId: process.env.PPT_PARTNER_ORG?.trim() || null,
    memberId: process.env.PPT_PARTNER_MEMBER?.trim() || null,
  };
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

/** 多趟提取分区上限（趟数）。每趟是一次真实 AI 调用；超大仓库耗尽即停（覆盖率随后披露）。 */
export function analysisMaxPartitions() {
  const raw = Number(process.env.ANALYSIS_MAX_PARTITIONS ?? "");
  return Number.isInteger(raw) && raw > 0 ? raw : 6;
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
