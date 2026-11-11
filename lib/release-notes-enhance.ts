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
    "3. 输出一段话（20-60 字）：行为陈述式——写『谁能做什么 / 什么情况下会发生什么』，含具体动作与结果；如有边界条件（限流、重试、除非…否则）一并写出。避免内部术语、代码路径名与 EC-n/ER-n/HP-n 场景编号（也不要写『场景』二字）。",
    "4. 语气：事实、平实、无感叹号、无营销腔。",
    ...(input.emphasis.trim() ? [`4. 全篇强调语是「${input.emphasis.trim()}」，改写向它对齐。`] : []),
    ...(input.instruction.trim() ? [`5. 用户指令：${input.instruction.trim().slice(0, 200)}`] : []),
    "",
    `【原文】${kind} ${subject}${input.highlightType ? `（${input.highlightType}）` : ""}：${input.summary}`,
  ].join("\n");
}

const outputSchema = z.object({ summary: z.string().min(1).max(4000) });

/**
 * 展示文本净化（机械兜底）：prompt 已禁场景编号，模型仍偶发漏网——
 * 公告正文不得出现 EC-n/ER-n/HP-n 内部编号（调研红线），确定性剥除；
 * 锚定数据（spec_change id / scenario_reference）在库不变，仅影响展示文本。
 */
export function stripScenarioRefs(text: string): string {
  let out = text.replace(/[（(]?\s*(?:场景\s*)?(?:EC|ER|HP)-\d+\s*[）)]?\s*/g, "");
  out = out.replace(/涉及场景[。，；]?/g, "").replace(/场景。/g, "。");
  return out.replace(/\s{2,}/g, " ").trim();
}

/** 解析 AI 输出：容忍围栏/前后缀，取首个 { 到末个 }；结构不合格抛错（不落库）。 */
export function parseEnhancedSummary(content: string): string {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = outputSchema.safeParse(JSON.parse(stripped.slice(start, end + 1)));
    if (parsed.success) return stripScenarioRefs(parsed.data.summary.trim());
    throw new Error(parsed.error.issues[0]?.message ?? "AI 改写结构不合格");
  }
  // 纯文本输出直接采纳（更宽容的解析路径，仍受长度上限约束）
  const text = stripped.trim();
  if (!text || text.length > 4000) throw new Error("AI 改写为空或超长");
  return stripScenarioRefs(text);
}

export interface HeadlineInput {
  releaseTitle: string;
  /** 该发布全部条目的改写后文案（用户影响语言）。 */
  bullets: string[];
}

/** 合成公告标题（Specsight 形态）：一句平实的公告式标题，非 commit 信息。 */
export function buildHeadlinePrompt(input: HeadlineInput): string {
  return [
    "为一次产品发布写一条公告标题。用简体中文。",
    "要求：一句话、不超过 40 字；平实的行为/能力陈述（如『一条命令连接 Claude 与产品规格』），不要营销腔、不要感叹号、不要泛泛的『优化体验』；概括下面全部条目中最主要的一两件事。",
    "只返回 JSON：{\"headline\":\"...\"}",
    "",
    "【发布条目】",
    ...input.bullets.map((bullet, index) => `${index + 1}. ${bullet}`),
    input.releaseTitle ? `【提交标题（仅供参考，不要照抄）】${input.releaseTitle}` : "",
  ].join("\n");
}

const headlineSchema = z.object({ headline: z.string().min(1).max(200) });

export function parseHeadline(content: string): string {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = headlineSchema.safeParse(JSON.parse(stripped.slice(start, end + 1)));
    if (parsed.success) return stripScenarioRefs(parsed.data.headline.trim());
    throw new Error(parsed.error.issues[0]?.message ?? "标题结构不合格");
  }
  const text = stripScenarioRefs(stripped.trim());
  if (!text || text.length > 200) throw new Error("AI 标题为空或超长");
  return text;
}

export interface DraftBlockForRewrite {
  position: number;
  kind: string;
  featureName: string;
  scenarioReference: string;
  summary: string;
  highlightType: string | null;
}

/**
 * 批量把草稿块的「规格 diff 语言」改写为「用户影响语言」（业界共识：公告只写
 * 用户能做什么/什么被修了，内部场景号与类型码不进正文）。每块一次调用，
 * 锚定与证据不变（只写 summary_override，人工发布门禁不变）；单块失败回退原文不阻塞。
 * 计费与单块 Enhance 同通道（call_kind='release_note_enhance'，receipt-only）。
 */
export async function rewriteDraftBlocksToUserVoice(
  execute: { execute: (sql: string, params?: unknown[]) => Promise<unknown> },
  deps: {
    /** 结构化签名与 lib/ai.ts requestStructuredCompletion 对齐（调用方传入，保持本模块无 AI 依赖）。 */
    completion: (messages: Array<{ role: string; content: string }>, billing: { runId: number | null; accountId: number | null; chargeComponent: "main" | "platform_shadow"; callKind?: string | null }) => Promise<string>,
  },
  input: { noteId: number; emphasis: string; blocks: DraftBlockForRewrite[] },
): Promise<{ rewritten: number; failed: number }> {
  let rewritten = 0;
  let failed = 0;
  for (const block of input.blocks) {
    if (!block.summary.trim()) {
      failed += 1;
      continue;
    }
    try {
      const content = await deps.completion(
        [
          { role: "system", content: "你是严谨的发布说明编辑，只改写措辞不改变事实。" },
          { role: "user", content: buildEnhancePrompt({
            kind: block.kind,
            featureName: block.featureName,
            scenarioReference: block.scenarioReference,
            summary: block.summary,
            highlightType: block.highlightType,
            emphasis: input.emphasis,
            instruction: "面向产品的使用者（客户/同事）撰写：写他们能感知到什么变化，不要出现内部术语、场景编号或『场景』『规格』字样。",
          }) },
        ],
        { runId: null, accountId: null, chargeComponent: "main", callKind: "release_note_enhance" },
      );
      const suggestion = parseEnhancedSummary(content);
      await execute.execute("UPDATE release_note_blocks SET summary_override = ? WHERE release_note_id = ? AND position = ?", [suggestion, input.noteId, block.position]);
      rewritten += 1;
    } catch (error) {
      failed += 1;
      console.warn("[release-notes] block rewrite failed; keeping spec summary", { noteId: input.noteId, position: block.position, error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    }
  }
  return { rewritten, failed };
}

export interface HeadlineRewriteOutcome {
  headline: string | null;
}

/** 合成公告标题并落库（release_notes.headline，人工可改）。best-effort：失败返回 null。 */
export async function composeHeadline(
  execute: { execute: (sql: string, params?: unknown[]) => Promise<unknown> },
  deps: { completion: (messages: Array<{ role: string; content: string }>, billing: { runId: number | null; accountId: number | null; chargeComponent: "main" | "platform_shadow"; callKind?: string | null }) => Promise<string> },
  input: { noteId: number; bullets: string[]; releaseTitle: string },
): Promise<HeadlineRewriteOutcome> {
  try {
    const content = await deps.completion(
      [
        { role: "system", content: "你是产品公告编辑，只输出合规的标题。" },
        { role: "user", content: buildHeadlinePrompt({ releaseTitle: input.releaseTitle, bullets: input.bullets }) },
      ],
      { runId: null, accountId: null, chargeComponent: "main", callKind: "release_note_enhance" },
    );
    const headline = parseHeadline(content);
    await execute.execute("UPDATE release_notes SET headline = ? WHERE id = ?", [headline, input.noteId]);
    return { headline };
  } catch (error) {
    console.warn("[release-notes] headline compose failed", { noteId: input.noteId, error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    return { headline: null };
  }
}
