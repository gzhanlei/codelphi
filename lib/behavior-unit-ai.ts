import { z } from "zod";
import { analysisSchema, normalizeScenarioAliases, type AnalysisResult } from "./ai";
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

export type BehaviorInternalKind = "pure_technical" | "covered_elsewhere" | "data_transform" | "other_evidence_backed";

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

function renderSourceSections(sources: TaskSource[], role: TaskSource["role"]): string {
  return sources
    .filter((source) => source.role === role)
    .map((source) => `--- ${source.path} 行 ${source.startLine}-${source.endLine} ---\n${renderNumbered(source)}`)
    .join("\n");
}

function renderRegionList(task: BehaviorExecutionTask): string {
  const ids = taskRegionIds(task);
  return task.anchorFragments
    .map((fragment, index) => {
      const ranges = fragment.ranges.map((range) => `${range.startLine}-${range.endLine}`).join("、");
      return `- ${ids[index]}：行 ${ranges}`;
    })
    .join("\n");
}

export function describeBehaviorTaskPrompt(task: BehaviorExecutionTask, sources: TaskSource[]): string {
  return [
    "你在向一位不了解此代码的工程师转述代码事实。只复述事实，不要判断是否值得写入产品规格、是否用户可感知、是否重要——判定由后续步骤完成。",
    "对下面列出的每个审查区域各输出一条复述：这段代码做什么（facts）、它的输入（inputs）、控制流（controlFlow）、对外部产生的效果（externalEffects，如数据库读写、外部 API 调用、权限或状态变化、事件发布、响应内容）。",
    "每个区域都必须有一条复述，不得合并、不得省略、不得互相引用结论；未观察到外部效果时 externalEffects 写「未观察到外部效果」，不得省略该区域。",
    "辅助上下文仅用于理解主内容，不属于审查区域，不要为其输出复述。",
    '只返回 JSON，不要 Markdown。结构：{"regions":[{"id":"R1","facts":"","inputs":"","controlFlow":"","externalEffects":""}]}',
    "",
    "【审查区域】",
    renderRegionList(task),
    "",
    "【主内容（带行号）】",
    renderSourceSections(sources, "primary"),
    "",
    "【辅助上下文（带行号，仅供理解）】",
    renderSourceSections(sources, "context") || "（无）",
  ].join("\n");
}

export function judgeBehaviorTaskPrompt(input: JudgePromptInput): string {
  const ids = taskRegionIds(input.task);
  const descriptionById = new Map(input.descriptions.map((description) => [description.id, description]));
  const descriptionLines = ids.map((id) => {
    const description = descriptionById.get(id);
    if (!description) return `- ${id}：（无复述，直接核对源码判定）`;
    return `- ${id}：facts：${description.facts}；inputs：${description.inputs}；controlFlow：${description.controlFlow}；externalEffects：${description.externalEffects}`;
  });
  const names = (input.knownFeatureNames ?? []).map((name) => name.trim()).filter(Boolean).slice(0, 60);
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
    "拿不准一律判 extracted 并输出场景（宁可多写一条，不可漏写一条）；只有能明确断言无独立外部效果且给出证据时才判 reviewed_internal。",
    "红线：共享的数据库写入、外部 API 调用、权限与状态转换、事件发布函数，不能仅因为「被其他单元调用」就判为内部实现——被调用不等于没有行为。",
    "每个结论和每个场景都必须带 evidence：path 必须来自下方实际读取的文件，startLine 使用输入的行号。",
    "规格按功能组织；场景包含情境、操作、结果，分类 happy/edge/error，reference 使用 HP-n/EC-n/ER-n；JSON 字段名逐字使用 context/action/outcome，禁止 result 等同义键。覆盖区域内的全部外部行为，不设置场景条数上限。",
    names.length > 0 ? `功能名优先复用以下既有功能名（同属一个产品能力的场景归入同一功能）：${names.join("、")}` : "将同属一个产品能力的场景归入同一功能名。",
    "只返回 JSON，不要 Markdown。结构：",
    '{"regions":[{"id":"R1","disposition":"extracted|reviewed_internal|unresolved","internalKind":"pure_technical|covered_elsewhere|data_transform|other_evidence_backed","reason":"","evidence":[{"path":"","startLine":1}],"scenarioRefs":["HP-1"],"relatedUnitKeys":[],"relatedScenarioRefs":[]}],"features":[{"name":"","summary":"","scenarios":[{"reference":"HP-1","context":"","action":"","outcome":"","category":"happy","evidence":[{"path":"","startLine":1}]}]}]}',
    "",
    "【审查区域】",
    renderRegionList(input.task),
    "",
    "【区域事实复述】",
    descriptionLines.join("\n"),
    "",
    "【主内容（带行号）】",
    renderSourceSections(input.sources, "primary"),
    "",
    "【辅助上下文（带行号，仅供理解）】",
    renderSourceSections(input.sources, "context") || "（无）",
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

const judgeSchema = z.object({
  regions: z.array(
    z.object({
      id: z.string().min(1).max(40),
      disposition: z.enum(["extracted", "reviewed_internal", "unresolved"]),
      internalKind: z.enum(["pure_technical", "covered_elsewhere", "data_transform", "other_evidence_backed"]).optional(),
      reason: z.string().max(2_000).optional(),
      evidence: z.array(evidenceSchema).max(10).default([]),
      scenarioRefs: z.array(z.string().regex(/^(?:HP|EC|ER)-\d+$/)).max(40).default([]),
      relatedUnitKeys: z.array(z.string().min(1).max(500)).max(20).optional(),
      relatedScenarioRefs: z.array(z.string().min(1).max(200)).max(40).optional(),
    }),
  ).max(200),
  features: z.array(analysisSchema.shape.features.element).max(50),
});

/** 与 lib/ai 归一层同口径的不可见字符清理（模型偶发在证据路径前后带零宽字符）。 */
const INVISIBLE_CHARS = /[\u200b\u200c\u200d\u2060\ufeff]/g;

function extractJsonObject(content: string): unknown {
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
