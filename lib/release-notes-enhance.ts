import { z } from "zod";

/**
 * A2 §4.3-3 Enhance 单块改写（GTM 桥面）：AI 基于锚定变化的原文重写该块文案。
 * 硬边界：改写只作用于 summary_override 展示文本——锚定的 spec_change 与证据集不变
 * （证据不进 prompt 输出、不解析回写），改写结果经人工确认后才经 PATCH 保存（人在环）。
 * 计费口径与介绍材料一致：免费 + 如实记账（call_kind='release_note_enhance'）。
 */

export interface EnhanceBlockInput {
  kind: string;
  featureName: string;
  scenarioReference: string;
  summary: string;
  highlightType: string | null;
  emphasis: string;
  /** 用户的改写指令（如「更简短」「强调给客服的影响」），可空。 */
  instruction: string;
}

export function buildEnhancePrompt(input: EnhanceBlockInput): string {
  const kindLabels: Record<string, string> = { added: "新增", changed: "更新", removed: "移除" };
  const kind = kindLabels[input.kind] ?? input.kind;
  const subject = input.scenarioReference ? `${input.featureName} · ${input.scenarioReference}` : input.featureName;
  return [
    "你在为一条客户向发布说明改写文案。用简体中文，只输出改写后的正文，不要标题、引号或解释。",
    "硬规则：",
    "1. 只基于【原文】给出的事实改写措辞，禁止新增原文没有的功能、数字、日期或承诺。",
    "2. 不改变事实含义；不确定的地方保持原文表述。",
    "3. 长度 1-3 句；客户可读，避免内部术语与代码路径名。",
    ...(input.emphasis.trim() ? [`4. 全篇强调语是「${input.emphasis.trim()}」，改写向它对齐。`] : []),
    ...(input.instruction.trim() ? [`5. 用户指令：${input.instruction.trim().slice(0, 200)}`] : []),
    "",
    `【原文】${kind} ${subject}${input.highlightType ? `（${input.highlightType}）` : ""}：${input.summary}`,
  ].join("\n");
}

const outputSchema = z.object({ summary: z.string().min(1).max(4000) });

/** 解析 AI 输出：容忍围栏/前后缀，取首个 { 到末个 }；结构不合格抛错（不落库）。 */
export function parseEnhancedSummary(content: string): string {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = outputSchema.safeParse(JSON.parse(stripped.slice(start, end + 1)));
    if (parsed.success) return parsed.data.summary.trim();
    throw new Error(parsed.error.issues[0]?.message ?? "AI 改写结构不合格");
  }
  // 纯文本输出直接采纳（更宽容的解析路径，仍受长度上限约束）
  const text = stripped.trim();
  if (!text || text.length > 4000) throw new Error("AI 改写为空或超长");
  return text;
}
