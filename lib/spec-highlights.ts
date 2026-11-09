import { normalizeSpecText } from "./spec-diff";

/**
 * A3 Highlight 九类分类（docs/specsight-gap-improvement-plan.md §4.2）。
 * 确定性规则打标（零 AI 成本、零幻觉面）：文本信号命中才标，绝大多数 change
 * 不打标（返回 null）。`Beta` 只做标注——静态分析对运行时 feature flag 结构性
 * 不可见（盲评 §5 披露），文案不得宣称「识别灰度」。reason 记录命中信号，可查。
 */

export const SPEC_HIGHLIGHT_TYPES = ["Heads-up", "Pricing", "Limits", "Privacy", "Security", "Access", "Integrations", "Beta", "News"] as const;

export type SpecHighlightType = (typeof SPEC_HIGHLIGHT_TYPES)[number];

export interface SpecChangeHighlightInput {
  entityType: string;
  kind: string;
  featureName: string;
  summary: string;
  before?: unknown;
  after?: unknown;
}

export interface SpecChangeHighlight {
  type: SpecHighlightType;
  reason: string;
}

/** 类别 → 命中信号词。匹配不区分大小写；中英并收（规格文本双语）。 */
const SIGNALS: Array<{ type: SpecHighlightType; patterns: RegExp[] }> = [
  { type: "Security", patterns: [/security/i, /breach(ed)? (password|list)/i, /encrypt/i, /credential|secret|api key/i, /sandbox/i, /安全/, /加密/, /凭证/] },
  { type: "Access", patterns: [/\badmin\b/i, /\brbac\b|\brole\b|\broles\b/i, /\bsso\b|oauth/i, /invite|inviting/i, /permission|access control/i, /权限/, /管理员/, /访问控制/] },
  { type: "Privacy", patterns: [/privacy/i, /telemetry|tracking|data collection/i, /gdpr|dpa/i, /cookie/i, /隐私/, /数据收集/, /埋点/] },
  { type: "Pricing", patterns: [/price|pricing/i, /\bbilling\b/i, /tier|plan (price|cost)/i, /\bfee\b/i, /定价/, /计费/, /价格/] },
  { type: "Limits", patterns: [/rate limit/i, /\bquota\b/i, /maximum|max(imum)? (length|size|count|requests)/i, /throttl/i, /上限/, /配额/, /限流/] },
  { type: "Integrations", patterns: [/integration|integrates/i, /webhook/i, /slack|jira|github|gitlab/i, /\bapi\b.*\bintegrat|third[- ]party/i, /集成/, /对接/] },
  { type: "Beta", patterns: [/feature flag/i, /\bflag\b/i, /\bbeta\b/i, /experimental|preview/i, /灰度/, /实验(性|阶段)?/, /预览版/] },
  { type: "Heads-up", patterns: [/break(ing)?|no longer|backwards?[- ]incompatib/i, /deprecat/i, /下线|废弃|破坏性|不再支持/] },
];

/** 文本信号都不命中时的兜底：结构性信号（removed → Heads-up，feature 级 added → News）。 */
function structuralHighlight(change: SpecChangeHighlightInput): SpecChangeHighlight | null {
  if (change.kind === "removed") {
    return { type: "Heads-up", reason: `kind=removed：${change.featureName} 有条目被移除，可能影响既有使用方式` };
  }
  if (change.kind === "added" && change.entityType === "feature") {
    return { type: "News", reason: `kind=added：新增功能「${change.featureName}」` };
  }
  return null;
}

export function classifySpecHighlight(change: SpecChangeHighlightInput): SpecChangeHighlight | null {
  const parts = [change.featureName, change.summary];
  for (const side of [change.before, change.after]) {
    if (side && typeof side === "object") {
      const record = side as Record<string, unknown>;
      parts.push(...Object.values(record).filter((value): value is string => typeof value === "string").map((value) => normalizeSpecText(value)));
    }
  }
  const text = parts.filter(Boolean).join("\n");
  for (const { type, patterns } of SIGNALS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) {
        return { type, reason: `信号词 ${pattern.source} 命中（${type} 类规则，确定性匹配非模型判断）` };
      }
    }
  }
  return structuralHighlight(change);
}
