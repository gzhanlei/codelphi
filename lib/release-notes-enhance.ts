import { z } from "zod";
import type { OutputLanguage } from "./analysis-language";

/**
 * 发布稿文案 AI 通道（A2 §4.3-3 + 用户裁决 2026-11-12：改写单位 = 功能）。
 * 三个用途共用一条记账通道（call_kind='release_note_enhance'，receipt-only 免费口径）：
 * 1. composeHeadline —— 合成公告标题（Specsight 的 H1，人工可改）；
 * 2. rewriteReleaseNoteCopy —— 功能级成文（一个功能一次调用，合并该功能全部变化记录
 *    为一条用户可读说明，重复合并；导语单独改写）；
 * 3. 单块 Enhance（buildEnhancePrompt）—— 手动润色单块文案。
 * 硬边界：只改写措辞不新增事实；锚定与证据不变；人工发布门禁不变。
 */

/** 展示文本净化（机械兜底）：prompt 已禁场景编号，模型偶发漏网——确定性剥除；
 * 锚定数据（spec_change id / scenario_reference）在库不变，仅影响展示文本。 */
export function stripScenarioRefs(text: string): string {
  let out = text.replace(/[（(]?\s*(?:场景\s*)?(?:EC|ER|HP)-\d+\s*[）)]?\s*/g, "");
  out = out.replace(/涉及场景[。，；]?/g, "").replace(/场景。/g, "。");
  return out.replace(/\s{2,}/g, " ").trim();
}

function unwrapJson(content: string): string {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 输出不含 JSON 结构");
  return stripped.slice(start, end + 1);
}

// ── 1. 单块 Enhance（手动润色） ──────────────────────────────────

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

export function buildEnhancePrompt(input: EnhanceBlockInput, language: OutputLanguage = "zh-CN"): string {
  const kindLabels: Record<string, string> = language === "en"
    ? { added: "Added", changed: "Updated", removed: "Removed" }
    : { added: "新增", changed: "更新", removed: "移除" };
  const kind = kindLabels[input.kind] ?? input.kind;
  const subject = input.scenarioReference ? `${input.featureName} · ${input.scenarioReference}` : input.featureName;
  if (language === "en") {
    return [
      "You are rewriting copy for one customer-facing release-note entry. Write in English and output only the rewritten body — no title, no quotes, no explanations.",
      "Hard rules:",
      "1. Rewrite only the facts stated in [Original]; never add features, numbers, dates or promises that are not there.",
      "2. Do not change the factual meaning; keep the original wording where unsure.",
      "3. Output one paragraph (20-60 words), behavior-statement style — who can do what / what happens under which condition, with concrete action and result; include boundary conditions when present. Avoid internal jargon, code paths and EC-n/ER-n/HP-n scenario references (and the word \"scenario\").",
      "4. Tone: factual, plain, no exclamation marks, no marketing voice.",
      ...(input.emphasis.trim() ? [`5. The global emphasis is \"${input.emphasis.trim()}\"; align the rewrite with it.`] : []),
      ...(input.instruction.trim() ? [`6. User instruction: ${input.instruction.trim().slice(0, 200)}`] : []),
      "",
      `[Original] ${kind} ${subject}${input.highlightType ? ` (${input.highlightType})` : ""}: ${input.summary}`,
    ].join("\n");
  }
  return [
    "你在为一条客户向发布说明改写文案。用简体中文，只输出改写后的正文，不要标题、引号或解释。",
    "硬规则：",
    "1. 只基于【原文】给出的事实改写措辞，禁止新增原文没有的功能、数字、日期或承诺。",
    "2. 不改变事实含义；不确定的地方保持原文表述。",
    "3. 输出一段话（20-60 字）：行为陈述式——写『谁能做什么 / 什么情况下会发生什么』，含具体动作与结果；如有边界条件一并写出。避免内部术语、代码路径名与 EC-n/ER-n/HP-n 场景编号（也不要写『场景』二字）。",
    "4. 语气：事实、平实、无感叹号、无营销腔。",
    ...(input.emphasis.trim() ? [`5. 全篇强调语是「${input.emphasis.trim()}」，改写向它对齐。`] : []),
    ...(input.instruction.trim() ? [`6. 用户指令：${input.instruction.trim().slice(0, 200)}`] : []),
    "",
    `【原文】${kind} ${subject}${input.highlightType ? `（${input.highlightType}）` : ""}：${input.summary}`,
  ].join("\n");
}

const enhanceOutputSchema = z.object({ summary: z.string().min(1).max(4000) });

export function parseEnhancedSummary(content: string): string {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = enhanceOutputSchema.safeParse(JSON.parse(stripped.slice(start, end + 1)));
    if (parsed.success) return stripScenarioRefs(parsed.data.summary.trim());
    throw new Error(parsed.error.issues[0]?.message ?? "AI 改写结构不合格");
  }
  const text = stripScenarioRefs(stripped.trim());
  if (!text || text.length > 4000) throw new Error("AI 改写为空或超长");
  return text;
}

// ── 2. 合成公告标题 ──────────────────────────────────────────────

export interface HeadlineInput {
  releaseTitle: string;
  /** 该发布全部条目的文案（用户影响语言）。 */
  bullets: string[];
}

export function buildHeadlinePrompt(input: HeadlineInput, language: OutputLanguage = "zh-CN"): string {
  if (language === "en") {
    return [
      "Write one announcement headline for a product release. Write in English.",
      "Requirements: one sentence, at most 15 words; a plain capability/change statement (e.g. \"One command to connect product specs with AI assistants\"); no marketing voice, no exclamation marks, no vague \"improved experience\"; summarize the one or two most important items below.",
      'Return JSON only: {"headline":"..."}',
      "",
      "[Release entries]",
      ...input.bullets.map((bullet, index) => `${index + 1}. ${bullet}`),
      input.releaseTitle.trim() ? `[Commit title (reference only, do not copy)] ${input.releaseTitle}` : "",
    ].join("\n");
  }
  return [
    "为一次产品发布写一条公告标题。用简体中文。",
    "要求：一句话、不超过 40 字；平实的能力/变化陈述（如『一条命令连接产品规格与 AI 助手』），不要营销腔、不要感叹号、不要泛泛的『优化体验』；概括下面全部条目中最主要的一两件事。",
    '只返回 JSON：{"headline":"..."}',
    "",
    "【发布条目】",
    ...input.bullets.map((bullet, index) => `${index + 1}. ${bullet}`),
    input.releaseTitle.trim() ? `【提交标题（仅供参考，不要照抄）】${input.releaseTitle}` : "",
  ].join("\n");
}

const headlineSchema = z.object({ headline: z.string().min(1).max(200) });

export function parseHeadline(content: string): string {
  const parsed = headlineSchema.safeParse(JSON.parse(unwrapJson(content)));
  if (parsed.success) return stripScenarioRefs(parsed.data.headline.trim());
  throw new Error(parsed.error.issues[0]?.message ?? "标题结构不合格");
}

// ── 3. 功能级成文（合并发布） ────────────────────────────────────

export interface DraftBlockForRewrite {
  kind: string;
  featureName: string;
  summary: string;
}

export interface FeatureCopyGroup {
  featureName: string;
  blocks: DraftBlockForRewrite[];
}

export type CopySection = "新增" | "改进" | "修复" | "移除";

export interface FeatureCopyEntry {
  feature: string;
  section: CopySection;
  text: string;
}

const SECTION_LIST = "新增 / 改进 / 修复 / 移除";

export function buildFeatureCopyPrompt(input: { featureName: string; emphasis: string; summaries: string[] }, language: OutputLanguage = "zh-CN"): string {
  if (language === "en") {
    const sections = "Added / Improved / Fixed / Removed";
    return [
      "You are writing the feature update note for a product release. Write in English.",
      `Feature: ${input.featureName}.`,
      "Hard rules:",
      "1. Below are several internal change records for this feature in this release (before deduplication): merge duplicate/similar content into one user-readable note; never list them one by one.",
      "2. Write only from these records: what users can perceive (new capability, changed behavior, fixed problem). Never invent features or numbers beyond the records.",
      "3. No internal jargon, code paths or EC-n/ER-n/HP-n scenario references, and no words like \"scenario\", \"spec\" or \"change record\".",
      "4. Length 1-3 sentences, at most 80 words; factual and plain.",
      `5. The section field: pick the closest one from ${sections} (new capability=Added; behavior change=Improved; bug fix=Fixed; feature retirement=Removed).`,
      'Return JSON only: {"section":"Added|Improved|Fixed|Removed","text":"..."}',
      "",
      "[Change records]",
      ...input.summaries.map((summary, index) => `${index + 1}. ${summary}`),
      input.emphasis.trim() ? `\n[Global emphasis] ${input.emphasis.trim()}` : "",
    ].join("\n");
  }
  return [
    "你在为一次产品发布撰写『功能更新说明』。用简体中文。",
    `对象功能：${input.featureName}。`,
    "硬规则：",
    "1. 下面是该功能在本次发布中的多条内部变化记录（去重前）：把重复/近似的内容合并成一条用户可读说明，禁止逐条罗列。",
    "2. 只基于这些记录写：用户能感知到什么变化（新增了什么能力、什么行为改变了、什么问题被修复）。禁止编造记录之外的功能与数字。",
    "3. 禁止出现内部术语、代码路径名、EC-n/ER-n/HP-n 场景编号，也不要写『场景』『规格』『变化记录』等字样。",
    "4. 长度 1-3 句、不超过 120 字；语气事实、平实。",
    `5. section 字段：从 ${SECTION_LIST} 中选一个最贴切的分类（新能力=新增；行为改变=改进；问题修复=修复；功能下线=移除）。`,
    '只返回 JSON：{"section":"新增|改进|修复|移除","text":"..."}',
    "",
    "【变化记录】",
    ...input.summaries.map((summary, index) => `${index + 1}. ${summary}`),
    input.emphasis.trim() ? `\n【全篇强调】${input.emphasis.trim()}` : "",
  ].join("\n");
}

// 双语枚举：英文模式模型返回英文 section 名，规范化映射到中文规范值（存量 feature_copy_json 存储形态不变）。
const SECTION_ALIASES: Record<string, CopySection | "省略"> = {
  新增: "新增", 改进: "改进", 修复: "修复", 移除: "移除", 省略: "省略",
  Added: "新增", Improved: "改进", Fixed: "修复", Removed: "移除", Skipped: "省略",
};

const featureCopySchema = z.object({
  section: z.string().refine((value) => value in SECTION_ALIASES, "section 不在允许的分类内"),
  text: z.string().max(600).default(""),
});

export function parseFeatureCopy(content: string): { section: CopySection | "省略"; text: string } {
  const parsed = featureCopySchema.safeParse(JSON.parse(unwrapJson(content)));
  if (parsed.success) return { section: SECTION_ALIASES[parsed.data.section] ?? "省略", text: stripScenarioRefs(parsed.data.text.trim()) };
  throw new Error(parsed.error.issues[0]?.message ?? "结构不合格");
}

// ── 4. 导语改写 ─────────────────────────────────────────────────

export function buildLeadPrompt(input: { releaseSummary: string }, language: OutputLanguage = "zh-CN"): string {
  if (language === "en") {
    return [
      "Rewrite the release summary below into a user-readable lead paragraph. Write in English.",
      "Requirements: merge duplicates; drop implementation details (internal component names, tables/fields, receipts, pipeline and other engineering vocabulary); keep only user-perceivable changes; 1-3 sentences, at most 80 words; plain, no marketing voice.",
      'Return JSON only: {"text":"..."}',
      "",
      `[Original] ${input.releaseSummary}`,
    ].join("\n");
  }
  return [
    "把下面这段发布摘要改写成用户可读的导语。用简体中文。",
    "要求：合并重复；去掉实现细节（内部组件名、表/字段、回执、pipeline 等工程词汇）；只保留使用者能感知的变化；1-3 句、不超过 120 字；平实无营销腔。",
    '只返回 JSON：{"text":"..."}',
    "",
    `【原文】${input.releaseSummary}`,
  ].join("\n");
}

const leadSchema = z.object({ text: z.string().min(1).max(600) });

export function parseLead(content: string): string {
  const parsed = leadSchema.safeParse(JSON.parse(unwrapJson(content)));
  if (parsed.success) return stripScenarioRefs(parsed.data.text.trim());
  throw new Error(parsed.error.issues[0]?.message ?? "结构不合格");
}

// ── 5. 整篇编排 ─────────────────────────────────────────────────

export type CopyCompletion = (
  messages: Array<{ role: string; content: string }>,
  billing: { runId: number | null; accountId: number | null; chargeComponent: "main" | "platform_shadow"; callKind?: string | null },
) => Promise<string>;

export interface ReleaseCopyOutcome {
  features: number;
  failed: number;
  lead: string | null;
  headline: string | null;
}

/** 功能级成文 + 导语改写：一次发布稿的整篇文案。单功能失败保留该功能原始条目（回退），不阻塞整篇。 */
export async function rewriteReleaseNoteCopy(
  execute: { execute: (sql: string, params?: unknown[]) => Promise<unknown> },
  deps: { completion: CopyCompletion },
  input: {
    noteId: number;
    releaseTitle: string;
    emphasis: string;
    releaseSummary: string;
    groups: FeatureCopyGroup[];
  },
  language: OutputLanguage = "zh-CN",
): Promise<ReleaseCopyOutcome> {
  const en = language === "en";
  const kindPrefix = (kind: string) => en
    ? (kind === "removed" ? "[Removed]" : kind === "added" ? "[Added]" : "[Changed]")
    : (kind === "removed" ? "[下线]" : kind === "added" ? "[新增]" : "[改变]");
  const editorCopy = en
    ? "You are a product announcements editor who merges internal change records into one user-readable feature update note; reword only, never change the facts."
    : "你是产品公告编辑，把内部变化记录合并成一条用户可读的功能更新说明，只改写措辞不改变事实。";
  const editorHeadline = en
    ? "You are a product announcements editor; output only a compliant headline."
    : "你是产品公告编辑，只输出合规的标题。";
  const editorLead = en
    ? "You are a product announcements editor; reword only, never change the facts."
    : "你是产品公告编辑，只改写措辞不改变事实。";
  const entries: FeatureCopyEntry[] = [];
  let failed = 0;
  for (const group of input.groups) {
    const summaries = group.blocks.map((block) => `${kindPrefix(block.kind)} ${block.summary}`);
    try {
      const content = await deps.completion(
        [
          { role: "system", content: editorCopy },
          { role: "user", content: buildFeatureCopyPrompt({ featureName: group.featureName, emphasis: input.emphasis, summaries }, language) },
        ],
        { runId: null, accountId: null, chargeComponent: "main", callKind: "release_note_enhance" },
      );
      const parsed = parseFeatureCopy(content);
      if (parsed.section !== "省略" && parsed.text.trim()) {
        entries.push({ feature: group.featureName, section: parsed.section, text: parsed.text });
      }
    } catch (error) {
      failed += 1;
      console.warn("[release-notes] feature copy failed; keeping raw summaries", { noteId: input.noteId, feature: group.featureName, error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    }
  }
  let headline: string | null = null;
  if (entries.length > 0) {
    try {
      const content = await deps.completion(
        [
          { role: "system", content: editorHeadline },
          { role: "user", content: buildHeadlinePrompt({ releaseTitle: input.releaseTitle, bullets: entries.map((entry) => entry.text) }, language) },
        ],
        { runId: null, accountId: null, chargeComponent: "main", callKind: "release_note_enhance" },
      );
      headline = parseHeadline(content);
    } catch (error) {
      console.warn("[release-notes] headline compose failed", { noteId: input.noteId, error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    }
  }
  let lead: string | null = null;
  if (input.releaseSummary.trim()) {
    try {
      const content = await deps.completion(
        [
          { role: "system", content: editorLead },
          { role: "user", content: buildLeadPrompt({ releaseSummary: input.releaseSummary }, language) },
        ],
        { runId: null, accountId: null, chargeComponent: "main", callKind: "release_note_enhance" },
      );
      lead = parseLead(content);
    } catch (error) {
      console.warn("[release-notes] lead rewrite failed", { noteId: input.noteId, error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
    }
  }
  await execute.execute("UPDATE release_notes SET feature_copy_json = ?, lead_override = ?, headline = COALESCE(?, headline) WHERE id = ?", [JSON.stringify(entries), lead, headline, input.noteId]);
  return { features: entries.length, failed, lead, headline };
}
