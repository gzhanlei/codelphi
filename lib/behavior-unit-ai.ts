import { z } from "zod";
import { analysisSchema, normalizeScenarioAliases, type AnalysisResult } from "./ai";
import type { OutputLanguage } from "./analysis-language";
import type { TaskSource } from "./behavior-inventory/planner";
import type { BehaviorExecutionTask } from "./behavior-inventory/types";

/**
 * Task 9 · 单元复述/判定提取的 AI 边界层（D4）：
 * 两步拆分——复述步只描述各 behavior/implicit_review 审查区域的代码事实（禁止判断是否
 * 值得写），判定步逐区域分类 extracted/reviewed_internal/unresolved 并给出受控内部实现
 * 结论。prompt 不含「每个功能 1-5 个场景」或任何显著性数量帽：提取阶段尽可能完整，
 * 合并阶段消除重复，展示阶段控制信息密度。
 * 解析只发生在本模块（边界）；状态推导在 behavior-unit-extraction（纯函数）。
 */

export type BehaviorAnchorDisposition = "extracted" | "reviewed_internal" | "unresolved";

/** internalKind 合法值集合（解析层剥除非法值的依据；no_code_content 是编排合成专用值，
 *  模型永远不会产出，也不在 AI 判定契约内）。 */
const INTERNAL_KIND_VALUES: ReadonlySet<string> = new Set([
  "pure_technical",
  "covered_elsewhere",
  "data_transform",
  "other_evidence_backed",
]);

/** no_code_content 仅由提取编排对纯空行区域确定性合成（无模型判定、零 AI 调用）；
 *  AI 判定契约（judgeSchema 的四值枚举）不变，模型永远不会产出该值。 */
export type BehaviorInternalKind = "pure_technical" | "covered_elsewhere" | "data_transform" | "other_evidence_backed" | "no_code_content";

export interface BehaviorRegionDescription {
  id: string;
  facts: string;
  inputs: string;
  controlFlow: string;
  externalEffects: string;
}

export interface BehaviorRegionConclusion {
  id: string;
  disposition: BehaviorAnchorDisposition;
  internalKind?: BehaviorInternalKind;
  reason?: string;
  evidence: Array<{ path: string; startLine?: number }>;
  scenarioRefs: string[];
  relatedUnitKeys?: string[];
  relatedScenarioRefs?: string[];
}

export interface BehaviorJudgeOutput {
  regions: BehaviorRegionConclusion[];
  features: AnalysisResult["features"];
}

export interface JudgePromptInput {
  task: BehaviorExecutionTask;
  sources: TaskSource[];
  descriptions: BehaviorRegionDescription[];
  knownFeatureNames?: string[];
  /** 有效单元 key 目录（related-reference）：relatedUnitKeys 只允许取自该清单，
   *  防止模型臆造不存在/已重命名的单元 key 造成激活期关联静默丢失。 */
  knownUnitKeys?: string[];
  /** 输出语言（Task 13 传 run.outputLanguage）；缺省 zh-CN，既有调用形态不变。 */
  language?: OutputLanguage;
}

/** 区域 id 只从任务分片顺序派生（R1…Rn）；AI 回显的 id 映射回确定性 fragment，不承担身份。 */
export function taskRegionIds(task: BehaviorExecutionTask): string[] {
  return task.anchorFragments.map((_, index) => `R${index + 1}`);
}

function renderNumbered(source: TaskSource): string {
  return source.content
    .split("\n")
    .map((line, offset) => `${source.startLine + offset}: ${line}`)
    .join("\n");
}

function renderSourceSections(sources: TaskSource[], role: TaskSource["role"], language: OutputLanguage): string {
  return sources
    .filter((source) => source.role === role)
    .map((source) => {
      const header = language === "en"
        ? `--- ${source.path} lines ${source.startLine}-${source.endLine} ---`
        : `--- ${source.path} 行 ${source.startLine}-${source.endLine} ---`;
      return `${header}\n${renderNumbered(source)}`;
    })
    .join("\n");
}

function renderRegionList(task: BehaviorExecutionTask, language: OutputLanguage): string {
  const ids = taskRegionIds(task);
  return task.anchorFragments
    .map((fragment, index) => {
      const ranges = fragment.ranges.map((range) => `${range.startLine}-${range.endLine}`).join(language === "en" ? ", " : "、");
      return language === "en" ? `- ${ids[index]}: lines ${ranges}` : `- ${ids[index]}：行 ${ranges}`;
    })
    .join("\n");
}

export function describeBehaviorTaskPrompt(task: BehaviorExecutionTask, sources: TaskSource[], language: OutputLanguage = "zh-CN"): string {
  if (language === "en") {
    return [
      "You are relaying code facts to an engineer who does not know this code. Restate only the facts; do not judge whether the code is worth recording in a product spec, whether it is user-perceivable, or whether it is important — judgment happens in a later step.",
      "For every review region listed below, output one restatement: what the code does (facts), its inputs (inputs), its control flow (controlFlow), and its external effects (externalEffects, e.g. database reads/writes, external API calls, permission or state changes, event publication, response content).",
      "Every region must have exactly one restatement — no merging, no omission, no cross-referencing conclusions between regions; when no external effect is observed, write \"no external effect observed\" in externalEffects and still output the region.",
      "Auxiliary context is provided only to understand the primary content; it is not part of the review regions — do not restate it.",
      'Return JSON only, no Markdown. Structure: {"regions":[{"id":"R1","facts":"","inputs":"","controlFlow":"","externalEffects":""}]}',
      "",
      "[Review regions]",
      renderRegionList(task, language),
      "",
      "[Primary content (with line numbers)]",
      renderSourceSections(sources, "primary", language),
      "",
      "[Auxiliary context (with line numbers, for understanding only)]",
      renderSourceSections(sources, "context", language) || "(none)",
    ].join("\n");
  }
  return [
    "你在向一位不了解此代码的工程师转述代码事实。只复述事实，不要判断是否值得写入产品规格、是否用户可感知、是否重要——判定由后续步骤完成。",
    "对下面列出的每个审查区域各输出一条复述：这段代码做什么（facts）、它的输入（inputs）、控制流（controlFlow）、对外部产生的效果（externalEffects，如数据库读写、外部 API 调用、权限或状态变化、事件发布、响应内容）。",
    "每个区域都必须有一条复述，不得合并、不得省略、不得互相引用结论；未观察到外部效果时 externalEffects 写「未观察到外部效果」，不得省略该区域。",
    "辅助上下文仅用于理解主内容，不属于审查区域，不要为其输出复述。",
    '只返回 JSON，不要 Markdown。结构：{"regions":[{"id":"R1","facts":"","inputs":"","controlFlow":"","externalEffects":""}]}',
    "",
    "【审查区域】",
    renderRegionList(task, language),
    "",
    "【主内容（带行号）】",
    renderSourceSections(sources, "primary", language),
    "",
    "【辅助上下文（带行号，仅供理解）】",
    renderSourceSections(sources, "context", language) || "（无）",
  ].join("\n");
}

export function judgeBehaviorTaskPrompt(input: JudgePromptInput): string {
  const language: OutputLanguage = input.language ?? "zh-CN";
  const ids = taskRegionIds(input.task);
  const descriptionById = new Map(input.descriptions.map((description) => [description.id, description]));
  const descriptionLines = ids.map((id) => {
    const description = descriptionById.get(id);
    if (!description) {
      return language === "en" ? `- ${id}: (no restatement; judge directly from the source)` : `- ${id}：（无复述，直接核对源码判定）`;
    }
    return language === "en"
      ? `- ${id}: facts: ${description.facts}; inputs: ${description.inputs}; controlFlow: ${description.controlFlow}; externalEffects: ${description.externalEffects}`
      : `- ${id}：facts：${description.facts}；inputs：${description.inputs}；controlFlow：${description.controlFlow}；externalEffects：${description.externalEffects}`;
  });
  const names = (input.knownFeatureNames ?? []).map((name) => name.trim()).filter(Boolean).slice(0, 60);
  const unitKeys = (input.knownUnitKeys ?? []).map((key) => key.trim()).filter(Boolean);
  const template = '{"regions":[{"id":"R1","disposition":"extracted|reviewed_internal|unresolved","internalKind":"pure_technical|covered_elsewhere|data_transform|other_evidence_backed","reason":"","evidence":[{"path":"","startLine":1}],"scenarioRefs":["HP-1"],"relatedUnitKeys":[],"relatedScenarioRefs":[]}],"features":[{"name":"","summary":"","scenarios":[{"reference":"HP-1","context":"","action":"","outcome":"","category":"happy","evidence":[{"path":"","startLine":1}]}]}]}';
  if (language === "en") {
    return [
      "You are maintaining a product knowledge base. Below are per-region factual restatements of code review regions with the corresponding source. Establish the facts from the restatements and the source first, then judge every region — each region must have exactly one conclusion; none may be skipped.",
      "For each region choose exactly one of three dispositions:",
      "- extracted: the region contains behavior visible to an external observer (new/changed parameters, responses, permission boundaries, state transitions, error paths, retry/skip and other control flow) → output the corresponding scenarios in features and fill the region's scenarioRefs with the references of the scenarios you output.",
      "- reviewed_internal: evidence shows the region is internal implementation with no independent external effect → internalKind, reason and evidence are required, and scenarioRefs must be empty:",
      "  - pure_technical: purely technical assistance with no independent external effect;",
      "  - covered_elsewhere: its behavior is already expressed by another unit or scenario → you must also provide relatedUnitKeys or relatedScenarioRefs; missing relations are treated as unresolved;",
      "  - data_transform: internal data transformation with no independent external effect;",
      "  - other_evidence_backed: other internal implementation with explicit evidence; reason must explain why no independent external effect exists.",
      "- unresolved: insufficient evidence, uncertain judgment, or unreadable code.",
      "relatedUnitKeys must be copied verbatim from the following valid unit directory — never invent keys outside it; any key outside the directory counts as a missing relation and is treated as unresolved:",
      unitKeys.length > 0
        ? unitKeys.map((key) => `- ${key}`).join("\n")
        : "(no valid unit directory for this run: leave relatedUnitKeys empty; covered_elsewhere relations must be expressed with relatedScenarioRefs)",
      "When in doubt, judge extracted and output the scenario (one extra entry is better than one missed); judge reviewed_internal only when you can clearly assert there is no independent external effect and provide evidence.",
      'Red line: shared database writes, external API calls, permission and state transitions, and event publication functions must not be judged internal merely because they are "called by another unit" — being called does not mean having no behavior.',
      "Every conclusion and every scenario must carry evidence: path must come from the files actually read below, and startLine must use the input line numbers.",
      "Organize the spec by features; each scenario contains a context, an action and an outcome, classified happy/edge/error, with references HP-n/EC-n/ER-n; JSON field names must be exactly context/action/outcome — never synonym keys such as result. Cover all external behavior in the regions; there is no scenario-count limit.",
      names.length > 0 ? `Prefer reusing these existing feature names (scenarios belonging to one product capability go into one feature): ${names.join(", ")}` : "Group scenarios belonging to one product capability under one feature name.",
      "Return JSON only, no Markdown. Structure:",
      template,
      "",
      "[Review regions]",
      renderRegionList(input.task, language),
      "",
      "[Per-region factual restatements]",
      descriptionLines.join("\n"),
      "",
      "[Primary content (with line numbers)]",
      renderSourceSections(input.sources, "primary", language),
      "",
      "[Auxiliary context (with line numbers, for understanding only)]",
      renderSourceSections(input.sources, "context", language) || "(none)",
    ].join("\n");
  }
  return [
    "你在维护一个产品知识库。下面是对一批代码审查区域的逐区域事实复述与对应源码。先依据复述与源码看到事实，再逐区域判定——每个区域都必须有一条结论，不得跳过。",
    "对每个区域三选一判定：",
    "- extracted：该区域包含外部观察者可见的行为（新/变参数、响应、权限边界、状态转换、错误路径、重试或跳过等控制流）→ 在 features 中输出对应场景，并把输出场景的 reference 填入该区域的 scenarioRefs。",
    "- reviewed_internal：有证据表明该区域是不产生独立外部效果的内部实现 → 必须给出 internalKind、reason 与 evidence，且 scenarioRefs 必须为空：",
    "  - pure_technical：纯技术辅助，无独立外部效果；",
    "  - covered_elsewhere：其行为已由其他单元或场景表达 → 必须同时给出 relatedUnitKeys 或 relatedScenarioRefs，缺失按 unresolved；",
    "  - data_transform：内部数据转换，不产生独立外部效果；",
    "  - other_evidence_backed：其他有明确证据的内部实现，reason 必须解释为何不存在独立外部效果。",
    "- unresolved：证据不足、判断不确定或代码不可读。",
    "relatedUnitKeys 只能逐字取自以下有效单元清单，不得臆造清单外的 key；凡不在清单内的一律视为缺失关联，按 unresolved 处理：",
    unitKeys.length > 0
      ? unitKeys.map((key) => `- ${key}`).join("\n")
      : "（本次判定无有效单元清单：relatedUnitKeys 一律留空，covered_elsewhere 的关联只能用 relatedScenarioRefs 表达）",
    "拿不准一律判 extracted 并输出场景（宁可多写一条，不可漏写一条）；只有能明确断言无独立外部效果且给出证据时才判 reviewed_internal。",
    "红线：共享的数据库写入、外部 API 调用、权限与状态转换、事件发布函数，不能仅因为「被其他单元调用」就判为内部实现——被调用不等于没有行为。",
    "每个结论和每个场景都必须带 evidence：path 必须来自下方实际读取的文件，startLine 使用输入的行号。",
    "规格按功能组织；场景包含情境、操作、结果，分类 happy/edge/error，reference 使用 HP-n/EC-n/ER-n；JSON 字段名逐字使用 context/action/outcome，禁止 result 等同义键。覆盖区域内的全部外部行为，不设置场景条数上限。",
    names.length > 0 ? `功能名优先复用以下既有功能名（同属一个产品能力的场景归入同一功能）：${names.join("、")}` : "将同属一个产品能力的场景归入同一功能名。",
    "只返回 JSON，不要 Markdown。结构：",
    template,
    "",
    "【审查区域】",
    renderRegionList(input.task, language),
    "",
    "【区域事实复述】",
    descriptionLines.join("\n"),
    "",
    "【主内容（带行号）】",
    renderSourceSections(input.sources, "primary", language),
    "",
    "【辅助上下文（带行号，仅供理解）】",
    renderSourceSections(input.sources, "context", language) || "（无）",
  ].join("\n");
}

const evidenceSchema = z.object({
  path: z.string().min(1).max(500),
  startLine: z.number().int().positive().optional(),
});

const describeSchema = z.object({
  regions: z.array(
    z.object({
      id: z.string().min(1).max(40),
      facts: z.string().min(1).max(4_000),
      inputs: z.string().max(2_000).default(""),
      controlFlow: z.string().max(2_000).default(""),
      externalEffects: z.string().max(2_000).default(""),
    }),
  ).max(200),
});

/** inventory 判定专用宽松场景 schema（2026-11-20 bench 真库发现）：scenario evidence 的
 *  legacy 演示密度上限（max 5）会让密集区域整体 parse 失败 → 任务硬失败，与判定 prompt
 *  「不设条数上限」的契约矛盾。这里把 evidence 上限放宽到 20（仍防爆炸），其余字段口径
 *  与 analysisSchema 同源。 */
const BEHAVIOR_SCENARIO_SCHEMA = analysisSchema.shape.features.element.shape.scenarios.element.extend({
  evidence: z.array(analysisSchema.shape.features.element.shape.scenarios.element.shape.evidence.element).max(20),
});
const BEHAVIOR_FEATURE_SCHEMA = analysisSchema.shape.features.element.extend({
  scenarios: z.array(BEHAVIOR_SCENARIO_SCHEMA).max(40),
});

const judgeSchema = z.object({
  regions: z.array(
    z.object({
      id: z.string().min(1).max(40),
      disposition: z.enum(["extracted", "reviewed_internal", "unresolved"]),
      internalKind: z.enum(["pure_technical", "covered_elsewhere", "data_transform", "other_evidence_backed"]).optional(),
      reason: z.string().max(2_000).optional(),
      // 2026-11-22 bench 真库发现（同 7c22739 族）：task 臂 judge 对密集代码区域的
      // evidence max(10) 触发 51 次硬失败（zod too_big）——与 BEHAVIOR_SCENARIO_SCHEMA
      // 同口径放宽到 20，仍防爆炸。
      evidence: z.array(evidenceSchema).max(20).default([]),
      scenarioRefs: z.array(z.string().regex(/^(?:HP|EC|ER)-\d+$/)).max(40).default([]),
      relatedUnitKeys: z.array(z.string().min(1).max(500)).max(20).optional(),
      relatedScenarioRefs: z.array(z.string().min(1).max(200)).max(40).optional(),
    }),
  ).max(200),
  features: z.array(BEHAVIOR_FEATURE_SCHEMA).max(50),
});

/** 与 lib/ai 归一层同口径的不可见字符清理（模型偶发在证据路径前后带零宽字符）。 */
const INVISIBLE_CHARS = /[\u200b\u200c\u200d\u2060\ufeff]/g;

/** 导出供 execution batch 协议复用（Task 5 最小导出，容错提取逻辑不变）。 */
export function extractJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("AI response did not contain a JSON object");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function keepKnownRegions<T extends { id: string }>(regions: T[], task: BehaviorExecutionTask, stage: string): T[] {
  const known = new Set(taskRegionIds(task));
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const region of regions) {
    if (!known.has(region.id)) {
      console.warn("[analysis] behavior task region id dropped", { stage, id: region.id });
      continue;
    }
    if (seen.has(region.id)) {
      console.warn("[analysis] duplicate behavior task region conclusion dropped", { stage, id: region.id });
      continue;
    }
    seen.add(region.id);
    kept.push(region);
  }
  return kept;
}

/** 解析复述步输出：缺 regions 键按空复述容忍（判定步直接核对源码），只保留本任务已知区域。 */
export function parseDescribeContent(content: string, task: BehaviorExecutionTask): BehaviorRegionDescription[] {
  const raw = extractJsonObject(content) as { regions?: unknown };
  if (!Array.isArray(raw.regions)) {
    console.warn("[analysis] behavior task describe output missing regions; judging from source directly");
  }
  const parsed = describeSchema.parse({ regions: Array.isArray(raw.regions) ? raw.regions : [] });
  return keepKnownRegions(parsed.regions, task, "describe");
}

/** 解析判定步输出：features 走与主提取相同的归一/校验口径，区域结论过滤未知 id。
 *  缺 regions/features 键按空集合容忍（run 289 先例：缺键 → 空数组）——
 *  空结论由状态推导判 unresolved（语义未决），不升级为硬失败。 */
export function parseJudgeContent(content: string, task: BehaviorExecutionTask): BehaviorJudgeOutput {
  const raw = extractJsonObject(content) as { regions?: unknown; features?: unknown };
  const cleanedRegions = Array.isArray(raw.regions)
    ? raw.regions.map((region) => {
        if (typeof region !== "object" || region === null) return region;
        const record = { ...(region as Record<string, unknown>) };
        if (Array.isArray(record.evidence)) {
          record.evidence = record.evidence.map((item) => {
            if (typeof item !== "object" || item === null || typeof (item as { path?: unknown }).path !== "string") return item;
            const path = ((item as { path: string }).path).replace(INVISIBLE_CHARS, "").trim();
            return path ? { ...(item as Record<string, unknown>), path } : item;
          });
        }
        // internalKind 枚举外值（2026-11-20 bench 真库高频失败源）：剥掉该字段而非让整个
        // 任务 parse 崩溃——reviewed_internal 缺 kind 由状态推导落 unresolved（reason=
        // reviewed_internal_without_kind），走受控语义复核（I），绝不烧硬失败重试预算。
        if (record.internalKind != null && !INTERNAL_KIND_VALUES.has(String(record.internalKind))) {
          console.warn("[analysis] behavior judge internalKind outside enum; stripped to controlled unresolved", {
            stage: "judge",
            received: String(record.internalKind).slice(0, 40),
          });
          delete record.internalKind;
        }
        return record;
      })
    : raw.regions;
  if (!Array.isArray(cleanedRegions)) {
    console.warn("[analysis] behavior task judge output missing regions; all fragments stay unresolved");
  }
  const normalized = normalizeScenarioAliases({ features: raw.features });
  if (!Array.isArray(normalized.features)) {
    console.warn("[analysis] behavior task judge output missing features; normalized to empty");
  }
  const parsed = judgeSchema.parse({
    regions: Array.isArray(cleanedRegions) ? cleanedRegions : [],
    features: Array.isArray(normalized.features) ? normalized.features : [],
  });
  return { regions: keepKnownRegions(parsed.regions, task, "judge"), features: parsed.features };
}
