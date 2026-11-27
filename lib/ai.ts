import { z } from "zod";
import { requiredEnv } from "./env";
import { analyzedChangeFiles } from "./evidence";
import { AiOutputTruncatedError, type StructuredCompletionClient } from "./llm-client";
export { AiOutputTruncatedError } from "./llm-client";
import type { SourceFile } from "./github";
import { recordLlmCallReceipt, recordRequestScopedReceipt, type ChargeComponent, type LlmCallStage } from "./billing/cost-receipt";
import type { OutputLanguage } from "./analysis-language";
import type { PatchHunk } from "./spec-diff";
import { withNoSourceOutput } from "./prompt-policy";

const evidenceSchema = z.object({
  path: z.string().min(1).max(500),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  url: z.string().url().regex(/^https:\/\//i).optional(),
  note: z.string().max(500).optional(),
});

const scenarioSchema = z.object({
  reference: z.string().regex(/^(?:HP|EC|ER)-\d+$/),
  context: z.string().min(1).max(2_000),
  action: z.string().min(1).max(2_000),
  outcome: z.string().min(1).max(2_000),
  category: z.enum(["happy", "edge", "error"]),
  // W-DECISION 最小序列版：happy 场景 step=1..N 构成主步骤链，edge/error 的 step=分支自哪一步。
  // 不确定/未编号可缺省；非法值在归一层丢弃（docs/w-decision-scenario-sequence-plan.md §1）。
  step: z.number().int().min(1).max(40).nullish(),
  evidence: z.array(evidenceSchema).max(5),
});

export const analysisSchema = z.object({
  product: z.object({
    description: z.string().trim().min(1).max(1_000),
    evidence: z.array(evidenceSchema).min(1).max(5),
  }),
  release: z.object({
    title: z.string().min(1).max(300),
    summary: z.string().min(1).max(8_000),
  }),
  changes: z.array(z.object({
    featureName: z.string().min(1).max(191),
    kind: z.enum(["added", "changed", "removed", "fixed", "reviewed"]),
    description: z.string().min(1).max(4_000),
    userImpact: z.string().max(4_000).default(""),
    evidence: z.array(evidenceSchema).max(5),
  })).max(150),
  // 空 features 是合法回答（run 289，2026-11-12）：分区提取遇到 docs/测试/配置为主的窗口，
  // 模型会返回 product/release/changes 齐全但缺 features 键的 JSON。空趟按「无行为变化窗口」
  // 接受是既有语义（sanitizeEvidence 注释、parseBehavioralContent 同款回填），空版本由坍缩
  // 护栏（detectSpecCollapse）下游只告警不阻断，版本 append-only 可回溯。
  features: z.array(z.object({
    name: z.string().min(1).max(191),
    summary: z.string().min(1).max(4_000),
    scenarios: z.array(scenarioSchema).max(40),
  })).max(50),
});

export type AnalysisResult = z.infer<typeof analysisSchema>;

export function capEvidence(value: unknown) {
  const input = value as {
    product?: { evidence?: unknown[] };
    changes?: Array<{ evidence?: unknown[] }>;
    features?: Array<{ scenarios?: Array<{ evidence?: unknown[] }> }>;
  };
  return {
    ...input,
    product: input.product ? { ...input.product, evidence: input.product.evidence?.slice(0, 5) } : undefined,
    changes: input.changes?.map((change) => ({ ...change, evidence: change.evidence?.slice(0, 5) })),
    features: input.features?.map((feature) => ({
      ...feature,
      scenarios: feature.scenarios?.map((scenario) => ({ ...scenario, evidence: scenario.evidence?.slice(0, 5) })),
    })),
  };
}

/**
 * 模型输出归一（schema 校验前的解析层容忍，不改证据校验口径）：
 * ① 场景结果字段别名——生产实测（2026-11-10 run 174–179）模型会把提示语里的「结果」
 *    直译成 result 键，模板已声明 outcome 仍系统性漂移，zod 对多余键静默放行；
 * ② 证据路径不可见字符——模型偶发在路径前后带零宽字符（U+200B 等）或首尾空白，
 *    导致与分区允许集的精确匹配失败、合法引用被误杀（W0-2 superset 重跑实测）。
 */
const INVISIBLE_CHARS = /[\u200b\u200c\u200d\u2060\ufeff]/g;

function cleanEvidenceList(evidence: unknown): unknown {
  if (!Array.isArray(evidence)) return evidence;
  return evidence.map((item) => {
    if (typeof item !== "object" || item === null || typeof (item as { path?: unknown }).path !== "string") return item;
    const cleaned = { ...(item as Record<string, unknown>) };
    const path = (cleaned.path as string).replace(INVISIBLE_CHARS, "").trim();
    if (path) cleaned.path = path;
    return cleaned;
  });
}

export function normalizeScenarioAliases(value: unknown) {
  const input = value as {
    product?: { evidence?: unknown };
    changes?: Array<{ evidence?: unknown }>;
    features?: Array<{ scenarios?: Array<{ evidence?: unknown; reference?: unknown; step?: unknown }>; evidence?: unknown }>;
  };
  return {
    ...input,
    product: input.product ? { ...input.product, evidence: cleanEvidenceList(input.product.evidence) } : undefined,
    changes: input.changes?.map((change) => ({ ...change, evidence: cleanEvidenceList(change.evidence) })),
    features: input.features?.map((feature) => ({
      ...feature,
      evidence: cleanEvidenceList(feature.evidence),
      scenarios: feature.scenarios?.map((scenario) => {
        const cleaned = { ...scenario, evidence: cleanEvidenceList(scenario.evidence) } as Record<string, unknown>;
        // W-DECISION：step 非法（非整数/越界/空）直接丢弃并留痕，不拒绝整个响应——
        // 顺序是呈现增强不是判定面，回退扇出形态（docs/w-decision-scenario-sequence-plan.md §1）。
        const rawStep = cleaned.step;
        if (rawStep !== undefined && (typeof rawStep !== "number" || !Number.isInteger(rawStep) || rawStep < 1 || rawStep > 40)) {
          console.warn("[analysis] invalid scenario step dropped", { reference: String(scenario?.reference ?? "?"), step: rawStep });
          delete cleaned.step;
        }
        if (cleaned.outcome !== undefined || typeof cleaned.result !== "string") return cleaned;
        const { result, ...rest } = cleaned;
        return { ...rest, outcome: result };
      }),
    })),
  };
}

/**
 * 顶层集合键归一（run 289 教训，2026-11-12）：分区提取遇到无用户可感知功能的窗口，
 * ds-flash 两次重试都稳定返回 product/release/changes 齐全但缺 features 键的 JSON
 * （重试对输入 token 完全一致 = 同 prompt 确定性漂移）。解析层归一不改落库口径：
 * ① features/changes 缺键或非数组 → 空数组（空趟=合法回答，同 result→outcome 先例 ce92430）；
 * ② features 整体漂移到未知键 → 按 {name, scenarios} 形状识别提升（键名漂移同先例）。
 * product/release 不在此回填——主提取缺它们是真实失败，交由重试与 run 失败如实暴露。
 */
const KNOWN_TOP_LEVEL_KEYS = new Set(["product", "release", "changes", "features"]);

function isFeatureShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; scenarios?: unknown };
  return typeof candidate.name === "string" && Array.isArray(candidate.scenarios);
}

export function normalizeTopLevelCollections(json: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(json.features)) {
    const drifted = Object.entries(json).filter(
      ([key, value]) => !KNOWN_TOP_LEVEL_KEYS.has(key) && Array.isArray(value) && value.length > 0 && value.every(isFeatureShaped),
    );
    if (drifted.length === 1) {
      console.warn("[analysis] drifted top-level features key promoted", { from: drifted[0][0], size: (drifted[0][1] as unknown[]).length });
      json.features = drifted[0][1];
    } else {
      console.warn("[analysis] features collection missing in model output; normalized to empty", { keys: Object.keys(json).join(","), driftedCandidates: drifted.length });
      json.features = [];
    }
  }
  if (!Array.isArray(json.changes)) {
    console.warn("[analysis] changes collection missing in model output; normalized to empty", { keys: Object.keys(json).join(",") });
    json.changes = [];
  }
  return json;
}

export function parseAnalysisContent(content: string): AnalysisResult {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0) throw new Error("AI response did not contain a JSON object");
  const json = trimmed.slice(start, end + 1);
  if (!json.endsWith("}")) throw new Error("AI response did not contain a JSON object");
  return analysisSchema.parse(capScenariosPerFeature(capEvidence(normalizeScenarioAliases(normalizeTopLevelCollections(JSON.parse(json))))));
}

/**
 * 单功能场景数帽（schema max 40）：增量锚定会让 AI 原样回显上一版携带场景，
 * 变体噪音累积的功能（BM-5 类）很容易突破 40 → schema 硬顶拒绝 → 整个 run 失败。
 * 确定性截断（保序取前 40）让 run 成功；丢弃数打日志供账本/告警观察，根因治理在 BM-5 语义去重。
 */
export function capScenariosPerFeature(parsed: unknown, max = 40): unknown {
  if (typeof parsed !== "object" || parsed === null) return parsed;
  const features = (parsed as { features?: unknown }).features;
  if (!Array.isArray(features)) return parsed;
  for (const feature of features) {
    const scenarios = (feature as { scenarios?: unknown }).scenarios;
    if (!Array.isArray(scenarios) || scenarios.length <= max) continue;
    const name = typeof (feature as { name?: unknown }).name === "string" ? (feature as { name: string }).name : "?";
    console.warn(`[analysis] feature scenarios exceed cap ${scenarios.length}>${max}; truncating (BM-5 variant accumulation)`, { feature: name });
    (feature as { scenarios: unknown }).scenarios = scenarios.slice(0, max);
  }
  return parsed;
}

export interface ChangeContext {
  message: string;
  files: Array<{ path: string; status: string; patch: string; hunks?: readonly PatchHunk[] }>;
  /** 调用方已经算好的「含行为变更的路径集合」。客户端提案不带补丁文本；托管分析不填，从补丁算。 */
  behavioralPaths?: ReadonlySet<string>;
}

export function chatCompletionsUrl() {
  const configured = (process.env.AI_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
  if (configured.endsWith("/v1/chat/completions")) return configured;
  if (configured.endsWith("/v1")) return `${configured}/chat/completions`;
  return `${configured}/v1/chat/completions`;
}

const gatewayResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  choices: z.array(z.object({
    message: z.object({ content: z.string().optional() }).optional(),
    finish_reason: z.string().nullish(),
  })),
  usage: z.unknown().optional(),
});

export interface GatewayResponse {
  content: string;
  /** 网关原始 usage 对象（结构因 provider 而异，采集期只透传落库）；缺失时为 null。 */
  usage: unknown | null;
  requestId: string | null;
  /** 首个 choice 的 finish_reason（stop/length/…）；provider 未返回时为 null。 */
  finishReason: string | null;
}

export function gatewayResponse(value: unknown): GatewayResponse {
  const data = gatewayResponseSchema.parse(value);
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("AI gateway returned empty content");
  return {
    content,
    usage: data.usage ?? null,
    requestId: data.id === undefined ? null : String(data.id),
    finishReason: data.choices[0]?.finish_reason ?? null,
  };
}

async function requireSuccessfulAIResponse(response: Response) {
  if (!response.ok) throw new Error(`AI gateway ${response.status}: ${await response.text()}`);
}

/** B：把上一版功能名清单注入 prompt，约束命名与粒度连续，消除逐次重提取的改名风暴。 */
export function featureContinuitySection(previousFeatureNames?: string[], language: OutputLanguage = "zh-CN") {
  const names = (previousFeatureNames ?? []).map((name) => name.trim()).filter(Boolean).slice(0, 60);
  if (names.length === 0) return null;
  if (language === "en") {
    return [
      "[Feature list from the previous spec — keep naming continuous]",
      ...names.map((name) => `- ${name}`),
      ...(names.length >= 60 ? ["- (list truncated)"] : []),
      "Reuse the names and granularity of the existing features above; features whose behavior is unchanged must not be renamed or merged/reorganized; add a feature only when it is genuinely new.",
    ].join("\n");
  }
  return [
    "【上一版规格的功能清单——保持命名连续】",
    ...names.map((name) => `- ${name}`),
    ...(names.length >= 60 ? ["-（清单超长已截断）"] : []),
    "沿用上述既有功能的名称与粒度；行为未变的功能不得重命名、不得合并重组；仅当确属新能力时才新增功能。",
  ].join("\n");
}

export interface SpecAnchorScenario {
  reference: string;
  context: string;
  action: string;
  outcome: string;
  category: string;
  /** W-DECISION：有顺序标注的场景在锚定行里带上，受影响功能回显时保住主步骤链。 */
  step?: number | null;
}

export interface SpecAnchorFeature {
  name: string;
  summary: string;
  scenarios: SpecAnchorScenario[];
}

/** P0 措辞锚定：上一版规格的场景级文本，未变行为要求逐字沿用，消除全量重建的改写噪音。
 *  锚内容语言=上一版语言（语言切换 run 不注入锚，强制全量重建），框架文案随本次输出语言。 */
export function specAnchoringSection(previousSpec?: SpecAnchorFeature[], maxChars = 24_000, language: OutputLanguage = "zh-CN") {
  const features = (previousSpec ?? []).filter((feature) => feature.name.trim() && feature.scenarios.length > 0);
  if (features.length === 0) return null;
  if (language === "en") {
    const lines: string[] = ["[Full text of the previous spec — entries for unchanged behavior must be reused verbatim]"];
    let used = 0;
    let truncated = false;
    for (const feature of features) {
      const head = `[Feature: ${feature.name} (summary: ${feature.summary})]`;
      const scenarioLines = feature.scenarios.map((scenario) =>
        `- ${scenario.reference}｜${scenario.category}${scenario.step ? `｜step ${scenario.step}` : ""}｜Context: ${scenario.context}｜Action: ${scenario.action}｜Outcome: ${scenario.outcome}`,
      );
      const block = [head, ...scenarioLines].join("\n");
      if (used + block.length > maxChars) {
        truncated = true;
        break;
      }
      lines.push(block);
      used += block.length + 1;
    }
    return [
      ...lines,
      ...(truncated ? ["(The previous spec is too long and has been truncated; features not listed follow the original naming constraints.)"] : []),
      "Verbatim reuse rule: scenarios whose behavior is unchanged must reuse the previous reference and the exact context/action/outcome text — paraphrasing, reordering words and punctuation edits are all violations. Scenario text may change only because this commit actually changed that behavior; entries may be added/removed only because the behavior was genuinely added/removed.",
      "One behavior, one scenario: never create multiple entries for the same behavior from different roles, viewpoints or wordings (e.g. \"Editors view\" and \"Users view\" with the same outcome); output identical in meaning to an existing anchor entry is treated as reuse.",
      "Feature summaries are reused verbatim as well: as long as a feature's scenario set is unchanged, its summary must be identical to the previous version — no rewriting, expanding, adding or removing examples, or rewording; a summary changes only together with real scenario additions/removals/edits.",
    ].join("\n");
  }
  const lines: string[] = ["【上一版规格全文——行为未变的条目必须逐字沿用】"];
  let used = 0;
  let truncated = false;
  for (const feature of features) {
    const head = `功能：${feature.name}（简介：${feature.summary}）`;
    const scenarioLines = feature.scenarios.map((scenario) =>
      `- ${scenario.reference}｜${scenario.category}${scenario.step ? `｜步骤 ${scenario.step}` : ""}｜情境：${scenario.context}｜操作：${scenario.action}｜结果：${scenario.outcome}`,
    );
    const block = [head, ...scenarioLines].join("\n");
    if (used + block.length > maxChars) {
      truncated = true;
      break;
    }
    lines.push(block);
    used += block.length + 1;
  }
  return [
    ...lines,
    ...(truncated ? ["（上一版规格过长已截断，未列出的功能按原命名约束处理）"] : []),
    "逐字沿用规则：行为未变的场景必须原样复用上一版的编号与情境/操作/结果文字，同义改写、调整语序、增删标点都算违规；场景文字只能因本次代码确实改变了行为而修改，只能因行为确属新增/消失而增加/删除。",
    "同一行为只允许一条场景：禁止为同一行为从不同角色、视角或措辞重复建条（如「编辑者查看」与「用户查看」同一结果各写一条）；与锚中既有场景语义相同的输出一律按沿用处理。",
    "功能简介同样逐字沿用：只要一个功能的场景集没有变化，简介必须与上一版完全一致，禁止改写、扩写、增删例举或调整措辞；简介只能随场景的真实增删改一并修订。",
  ].join("\n");
}

/**
 * W0-10 · 增量输出三类契约（外部评审采纳）：旧契约「必须且只能包含上述功能」会把
 * 窗口中新发现的行为（新增入口/新模块/既有功能拆分）静默抑制——增量分析最危险的
 * 失败模式是错误地认定某功能不需要分析。三类输出：
 *   ① 清单内受影响功能：完整清单重新提取（覆盖与全量相当）；
 *   ② 清单外新发现：必须作为独立功能输出（系统按行为等价合并，不会重复）；
 *   ③ 未归属的行为变更文件：显式列出请模型特别核对（可能影响清单外功能或构成新功能）。
 * 其余既有功能由系统沿用上一版。零成本补救通道：宁可多写一条，不可漏写一条。
 */
export function incrementalScopeSection(affectedFeatureNames?: string[], unassignedBehavioralPaths?: readonly string[], language: OutputLanguage = "zh-CN") {
  if (!affectedFeatureNames || affectedFeatureNames.length === 0) return null;
  if (language === "en") {
    const parts = [
      "[Incremental analysis mode]",
      "Only the following features are analyzed in depth in this run (their code was touched by this commit):",
      ...affectedFeatureNames.map((name) => `- ${name}`),
      "All of the above features must be output: revise incrementally against the previous-spec anchor — scenarios whose behavior is unchanged reuse the original reference and text verbatim; genuinely changed behavior rewrites the corresponding entries; only genuinely new behavior adds entries; vanished behavior is no longer output. Per-feature output must not exceed the anchor count for that feature +3. Only when the anchor contains no such feature may you enumerate anew (usually 3-8 scenarios per feature, checking happy/edge/error exhaustively; boundary and error paths must not be omitted).",
      "[New discoveries outside the list — must be output] If you find user-perceivable behavior in the window code or diff that does not belong to any existing feature above — including new entry points, modules, endpoints, features introduced by new files, or splits of existing features — you must output it as an independent feature; do not omit it because it is not in the list.",
    ];
    if (unassignedBehavioralPaths && unassignedBehavioralPaths.length > 0) {
      parts.push("The following files were modified by this commit but are not yet attributed to any existing feature. Check their behavior changes carefully — they may affect behavior outside the listed features or constitute new features:");
      parts.push(...unassignedBehavioralPaths.map((path) => `- ${path}`));
    }
    parts.push("Except for the two categories above, the remaining existing features are carried over by the system from the previous spec; do not output them.");
    parts.push("The product description must still cover the entire commit. Final release copy is composed once from canonical spec changes; changes may contain only kind=reviewed audit candidates.");
    return parts.filter(Boolean).join("\n");
  }
  const parts = [
    "【增量分析模式】",
    "本次只深入分析以下功能（这些功能的代码被本次提交触及）：",
    ...affectedFeatureNames.map((name) => `- ${name}`),
    "上述功能必须全部输出：以上一版规格锚为基准做增量修订——行为未变的场景逐字沿用原编号与文字；行为确实变化的改写对应条目；确属新增的行为才新增条目；已消失的行为不再输出。每功能输出条数不得超过锚中该功能条数 +3。锚中没有该功能时才允许重新枚举（通常每功能 3-8 个场景，happy/edge/error 全部类别逐一检查，边界与错误路径不得省略）。",
    "【清单之外的新发现——必须输出】如果你在窗口代码或 diff 中发现不属于上述任何既有功能的用户可感知行为——包括新增的入口、模块、端点，新文件引入的新功能，或既有功能的拆分——必须作为独立功能输出，不得因为不在清单里而省略。",
  ];
  if (unassignedBehavioralPaths && unassignedBehavioralPaths.length > 0) {
    parts.push("以下文件被本次提交修改，但尚未归属到任何既有功能。请特别核对其行为变化——它们可能影响清单外功能的行为，也可能构成新功能：");
    parts.push(...unassignedBehavioralPaths.map((path) => `- ${path}`));
  }
  parts.push("除上述两类之外，其余既有功能由系统沿用上一版规格，请勿输出。");
  parts.push("product 简介仍需覆盖整个提交。发布说明由系统从规范 spec_changes 统一生成；changes 只能包含 kind=reviewed 审计候选。");
  return parts.filter(Boolean).join("\n");
}

export interface LlmBillingContext {
  /** 分析口径绑定 run；独立生成（介绍材料等）无 run，为 null + callKind 标注。 */
  runId: number | null;
  accountId: number | null;
  chargeComponent: ChargeComponent;
  callKind?: string | null;
  /** 行为清单全量分析的执行任务与尝试身份（migration 080）；旧分区/W0-8 调用不传，回执全部写 NULL。 */
  taskKey?: string | null;
  unitKey?: string | null;
  attemptId?: string | null;
  callStage?: LlmCallStage | null;
  /** 实际请求身份（migration 081）：batch/repair 请求必填（回执走 insert-or-reconcile）；legacy 可空。 */
  requestKey?: string | null;
  requestFingerprint?: string | null;
}

/** 主提取 JSON 契约模板（语言无关共享：键名/编号/枚举是英文结构约定）。 */
const ANALYSIS_JSON_TEMPLATE = '{"product":{"description":"","evidence":[{"path":"","startLine":1}]},"release":{"title":"","summary":""},"changes":[{"featureName":"","kind":"added|changed|removed|fixed|reviewed","description":"","userImpact":"","evidence":[{"path":"","startLine":1}]}],"features":[{"name":"","summary":"","scenarios":[{"reference":"HP-1","context":"","action":"","outcome":"","category":"happy","step":1,"evidence":[{"path":"","startLine":1}]}]}]}';

export function systemPrompt(language: OutputLanguage = "zh-CN") {
  return language === "en"
    ? "You are a rigorous code analyzer that outputs only verifiable structured facts."
    : "你是严谨的代码分析器，只输出可验证的结构化事实。";
}

export function partitionNotice(index: number, total: number, language: OutputLanguage = "zh-CN") {
  return language === "en"
    ? `\n[Partitioned extraction]\nThis window is partition ${index}/${total} of the codebase and contains only part of it. Other partitions are extracted independently and the merge layer deduplicates and consolidates: cover every major user-facing capability inside this window, do not guess about modules outside the window, and never emit placeholder entries like "see other partitions".`
    : `\n【分区提取】\n本窗口是代码库的第 ${index}/${total} 个分区，只包含代码库的一部分。其他分区由独立提取负责，合并层会统一去重与归并：只需覆盖本窗口内的全部主要用户功能，不要猜测窗口外的模块，也不要输出「其他功能见其他分区」之类的占位条目。`;
}

/** 主提取指令段（双语）：zh 分支逐字节保持既有生产 prompt；en 分支为完整英文模板，
 *  显式禁止中文输出。coverageMandate 由调用方按分区/全量注入。 */
export function extractionInstructionLines(language: OutputLanguage, options: { coverageMandate: string }): string[] {
  if (language === "en") {
    return [
      "You are maintaining a product knowledge base. State only facts grounded in the given code and diff; do not add speculation.",
      "Generate the following in English — all natural-language text MUST be written in English, never Chinese: 1) the product description; 2) the current product feature spec.",
      "Do not write the final release changelog in an extraction pass: changes is reserved for kind=reviewed internal-implementation audit candidates; final release copy is composed once from canonical spec changes after all passes merge.",
      "release.title and release.summary must be non-empty internal extraction metadata, not final release notes; use a short label for the current extraction window.",
      "The product description is one or two sentences naming the audience and the core capability, at most 200 characters, summarizing the whole codebase rather than this commit, and carries evidence from the input files; do not write just the product name or marketing copy.",
      "Organize the spec by features; every scenario contains a context, an action and an outcome, classified happy/edge/error, with references HP-n/EC-n/ER-n. JSON field names must match the template below verbatim (context/action/outcome); never use synonym keys such as result.",
      "Scenarios may carry an optional step: happy scenarios are numbered step=1..N in delivery order (within one feature and one context); an edge/error scenario's step is the happy step it branches from; omit step when the order is unclear and never invent one.",
      options.coverageMandate,
      "Prioritize feature coverage: keep the 1-5 most important scenarios per feature; do not miss other features because a single feature has too many scenarios.",
      "Every scenario, reviewed audit candidate and the product description must carry evidence; path must come from the input files and startLine must use the input line numbers. When there is no internal implementation to audit, return changes=[].",
      "Return JSON only, no Markdown. Structure:",
    ];
  }
  return [
    "你在维护一个产品知识库。仅根据给定代码和 diff 输出事实，不要补充猜测。",
    "用简体中文生成：1) 产品简介；2) 当前产品功能规格。",
    "提取趟不得撰写最终发布变化清单：changes 仅用于 kind=reviewed 的内部实现审计候选；全部提取合并后，系统会从规范 spec_changes 统一生成发布说明。",
    "release.title 和 release.summary 必须是非空的内部分区元数据，不是最终发布说明；用简短标签概括当前提取窗口。",
    "产品简介用一到两句话说明服务对象和核心能力，不超过 200 字，必须概括整个代码库而不是本次提交，并给出输入文件中的 evidence；不要只写产品名或营销词。",
    "规格按功能组织，每个场景包含情境、操作、结果，分类为 happy/edge/error，reference 使用 HP-n/EC-n/ER-n。JSON 字段名必须与下方模板逐字一致：情境=context、操作=action、结果=outcome，禁止用 result 等同义键名。",
    "场景可选标注 step：happy 场景按交付顺序标 step=1..N（同一功能同一情境内）；edge/error 场景的 step=其分支自的 happy 步骤号；不确定顺序时不写 step，不得编造。",
    options.coverageMandate,
    "优先保证功能覆盖，每个功能保留最关键的 1-5 个场景；不要因单个功能场景过多而遗漏其他功能。",
    "每个场景、reviewed 审计候选和产品简介必须给 evidence；path 必须来自输入文件，startLine 使用输入的行号。没有内部实现需要审计时返回 changes=[]。",
    "只返回 JSON，不要 Markdown。结构：",
  ];
}

export function buildAnalysisMessages(sources: SourceFile[], change: ChangeContext, context: { previousFeatureNames?: string[]; previousSpec?: SpecAnchorFeature[]; affectedFeatureNames?: string[]; unassignedBehavioralPaths?: string[]; partition?: { index: number; total: number }; outputLanguage?: "zh-CN" | "en"; noSourceOutput?: boolean } = {}) {
  const language: OutputLanguage = context.outputLanguage ?? "zh-CN";
  const anchor = specAnchoringSection(context.previousSpec, 24_000, language);
  const continuity = anchor ? null : featureContinuitySection(context.previousFeatureNames, language);
  const scope = incrementalScopeSection(context.affectedFeatureNames, context.unassignedBehavioralPaths, language);
  const partition = context.partition;
  const partitionSection = partition ? partitionNotice(partition.index, partition.total, language) : null;
  const coverageMandate = language === "en"
    ? (partition
      ? "The current product feature spec must cover every major user-facing capability in this window of code. Check every page, API, component and business module in the input; when the input contains several independent modules, returning only one feature is an incomplete result."
      : "The current product feature spec must cover every major user-facing capability in the input code, not merely summarize this commit. Check every page, API, component and business module in the input; when the input contains several independent modules, returning only one feature is an incomplete result.")
    : (partition
      ? "当前产品功能规格必须覆盖本窗口代码里的全部主要用户功能。逐个检查输入中的页面、API、组件和业务模块；输入包含多个独立模块时，只返回一个功能属于不完整结果。"
      : "当前产品功能规格必须覆盖输入代码里的全部主要用户功能，不得只总结本次提交。逐个检查输入中的页面、API、组件和业务模块；输入包含多个独立模块时，只返回一个功能属于不完整结果。");
  // 迁移脚本已移出分析目标：补丁不进提示词，模型也就无从引用它（证据允许集同样不含它）。
  const analyzedFiles = analyzedChangeFiles(change.files);
  const commitSection = language === "en"
    ? `\n[Commit]\n${change.message}\n\n[Changed files]\n${JSON.stringify(analyzedFiles)}`
    : `\n【本次提交】\n${change.message}\n\n【文件变化】\n${JSON.stringify(analyzedFiles)}`;
  const codeSection = language === "en"
    ? `\n[Current code, with line numbers]\n${sources.map((file) => `\n--- ${file.path} ---\n${file.content}`).join("\n")}`
    : `\n【当前代码，带行号】\n${sources.map((file) => `\n--- ${file.path} ---\n${file.content}`).join("\n")}`;
  const prompt = [
    ...extractionInstructionLines(language, { coverageMandate }),
    ANALYSIS_JSON_TEMPLATE,
    ...(anchor ? [anchor] : []),
    ...(continuity ? [continuity] : []),
    ...(scope ? [scope] : []),
    ...(partitionSection ? [partitionSection] : []),
    commitSection,
    codeSection,
  ].join("\n");

  return [
    { role: "system", content: systemPrompt(language) },
    // 客户端分析（noSourceOutput）才加「不输出源码」的硬约束；托管分析不传，提示词不变（修订稿 §4.2）。
    { role: "user", content: withNoSourceOutput(prompt, language, context.noSourceOutput) },
  ];
}

export async function analyzeWithAI(sources: SourceFile[], change: ChangeContext, context: { previousFeatureNames?: string[]; previousSpec?: SpecAnchorFeature[]; affectedFeatureNames?: string[]; unassignedBehavioralPaths?: string[]; partition?: { index: number; total: number }; outputLanguage?: "zh-CN" | "en"; billing?: LlmBillingContext; client?: StructuredCompletionClient; noSourceOutput?: boolean } = {}): Promise<AnalysisResult> {
  const messages = buildAnalysisMessages(sources, change, context);
  const content = context.client
    ? await context.client.complete(messages)
    : await requestStructuredCompletion(messages, context.billing);
  return parseAnalysisContent(content);
}

export interface StructuredCompletionDetails {
  content: string;
  usageRaw: unknown | null;
  providerRequestId: string | null;
  finishReason: string | null;
}

/**
 * 网关调用 + 回执记账的共享体（契约 M0-T2 → Task 4 扩展）：超时/失败/截断各落一条记录；
 * 详细版额外返回 usage/providerRequestId/finishReason 并实测 duration_ms（新增观测，不回填历史）。
 * batch/repair 请求经 billing.requestKey 携带实际请求身份 → 回执走 insert-or-reconcile（冲突上报）；
 * legacy 调用无请求身份 → 保持 best-effort 盲插。length 不在详细版抛出：原始截断响应必须先持久化
 * 再解析（§23.3 C3.4）；legacy wrapper 保持抛 AiOutputTruncatedError 的既有契约。
 */
export async function requestStructuredCompletionDetailed(messages: Array<{ role: string; content: string }>, billing?: LlmBillingContext): Promise<StructuredCompletionDetails> {
  const model = requiredEnv("AI_MODEL");
  const startedAtMs = Date.now();
  const recordReceipt = async (outcome: "success" | "failed" | "timeout", usageRaw: unknown | null, providerRequestId: string | null): Promise<void> => {
    if (!billing) return;
    const receipt = {
      runId: billing.runId,
      accountId: billing.accountId,
      chargeComponent: billing.chargeComponent,
      callKind: billing.callKind ?? null,
      taskKey: billing.taskKey ?? null,
      unitKey: billing.unitKey ?? null,
      attemptId: billing.attemptId ?? null,
      callStage: billing.callStage ?? null,
      model,
      outcome,
      usageRaw,
      providerRequestId,
      requestKey: billing.requestKey ?? null,
      requestFingerprint: billing.requestFingerprint ?? null,
      durationMs: Date.now() - startedAtMs,
    };
    if (billing.requestKey && billing.requestFingerprint) {
      await recordRequestScopedReceipt({ ...receipt, requestKey: billing.requestKey, requestFingerprint: billing.requestFingerprint });
    } else {
      await recordLlmCallReceipt(receipt);
    }
  };
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requiredEnv("AI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: 16_000,
        stream: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS ?? 180_000)),
    });
  } catch (error) {
    // 调用级回执即时写入（契约 M0-T2）：超时与失败都要落一条 unknown-usage 记录
    await recordReceipt(isAbortTimeout(error) ? "timeout" : "failed", null, null);
    throw error;
  }
  if (!response.ok) {
    await recordReceipt("failed", null, null);
    await requireSuccessfulAIResponse(response);
  }
  const payload: unknown = await response.json();
  let content: string;
  let usage: unknown | null;
  let requestId: string | null;
  let finishReason: string | null;
  try {
    ({ content, usage, requestId, finishReason } = gatewayResponse(payload));
  } catch (error) {
    // 网关返回 2xx 但结构不可解析：usage 若存在仍要落库（成本已发生）
    const payloadRecord = payload as { usage?: unknown } | null;
    await recordReceipt("failed", payloadRecord?.usage ?? null, null);
    throw error;
  }
  if (finishReason === "length") {
    // 截断是确定性失败：照常落 usage 回执（成本已发生）；详细版返回原始截断响应交由上层持久化
    await recordReceipt("failed", usage, requestId);
    return { content, usageRaw: usage, providerRequestId: requestId, finishReason };
  }
  await recordReceipt("success", usage, requestId);
  return { content, usageRaw: usage, providerRequestId: requestId, finishReason };
}

/** legacy 契约保持不变：只返回 content，length 抛 AiOutputTruncatedError（回执已由详细版落库）。 */
export async function requestStructuredCompletion(messages: Array<{ role: string; content: string }>, billing?: LlmBillingContext): Promise<string> {
  const details = await requestStructuredCompletionDetailed(messages, billing);
  if (details.finishReason === "length") throw new AiOutputTruncatedError();
  return details.content;
}

/** W0-8 行为面枚举：逐文件显式提问的定向提取（小 prompt、强制逐文件回答）。 */
export interface BehavioralTarget {
  path: string;
  /** 该文件在本窗口的 unified diff patch。 */
  patch: string;
  /** 变更区上下文（带行号的代码行）。 */
  contextBlocks: Array<{ startLine: number; endLine: number; content: string }>;
}

/**
 * W0-9 · 复述与判定分离（patch-anchored 两步提取）：
 * 单步提取把「复述变更」与「判断是否值得写」混在一次注意力里，显著性过滤会静默吞掉
 * 低显著的边缘行为（W0-7 后残余 L8/L15 实测：文件已读、已显式提问，仍答「无可感知行为」）。
 * 两步拆开：第一步只复述每个变更块的改前/改后（机械任务，接近确定代码的理解上限）；
 * 第二步对每条复述显式判定，判定标准偏向计入（拿不准 → 计入；判为内部实现 → reviewed
 * 条目留痕而非丢弃——宽松模式教训：错漏真行为 > 多留一条边缘条目）。
 */

export interface BehavioralDescription {
  path: string;
  /** 变更块标识（hunk 行区间）。 */
  hunk: string;
  /** 改前这段代码做什么。 */
  before: string;
  /** 改后这段代码做什么。 */
  after: string;
}

export function behavioralDescribePrompt(targets: BehavioralTarget[], change: ChangeContext, language: OutputLanguage = "zh-CN"): string {
  const contextHeader = (startLine: number, endLine: number) =>
    language === "en" ? `[Changed-region context ${startLine}-${endLine} (with line numbers)]` : `【变更区上下文 ${startLine}-${endLine}（带行号）】`;
  const sections = targets.map((target) => {
    const blocks = target.contextBlocks
      .map((block) => `${contextHeader(block.startLine, block.endLine)}\n${block.content}`)
      .join("\n");
    const noPatch = language === "en" ? "(no patch)" : "（无 patch）";
    return `--- File: ${language === "en" ? "" : "文件："}${target.path} ---\n${language === "en" ? "[Changed diff]" : "【变更 diff】"}\n${target.patch || noPatch}\n${blocks}`;
  });
  if (language === "en") {
    return [
      "You are relaying a code change to an engineer who does not know it. Restate only the facts; do not judge whether it is worth recording or user-perceivable.",
      "For every changed block (@@ range) of every file below, output one restatement: what the block did before and what it does after. Write in English.",
      "Every changed block must have one restatement — no merging, no omission; a file without changed blocks outputs empty changes.",
      'Return JSON only, no Markdown. Structure: {"files":[{"path":"","changes":[{"hunk":"","before":"","after":""}]}]}',
      `\n[Commit]\n${change.message}`,
      "\n[Changed files (per-file diff and changed-region context)]\n" + sections.join("\n"),
    ].join("\n");
  }
  return [
    "你在向一位不了解此变更的工程师转述代码变更。只复述事实，不要判断是否值得写、是否用户可感知。",
    "对下面每个文件的每个变更块（@@ 区间）输出一条复述：改前这段代码做什么、改后做什么。用简体中文。",
    "每个变更块都必须有一条复述，不得合并、不得省略；文件没有变更块则输出空 changes。",
    '只返回 JSON，不要 Markdown。结构：{"files":[{"path":"","changes":[{"hunk":"","before":"","after":""}]}]}',
    `\n【本次提交】\n${change.message}`,
    "\n【变更文件（逐文件 diff 与变更区上下文）】\n" + sections.join("\n"),
  ].join("\n");
}

export function parseBehavioralDescriptions(content: string, targets: BehavioralTarget[]): BehavioralDescription[] {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0) throw new Error("AI response did not contain a JSON object");
  const json = JSON.parse(trimmed.slice(start, end + 1)) as { files?: Array<{ path?: unknown; changes?: Array<{ hunk?: unknown; before?: unknown; after?: unknown }> }> };
  const known = new Set(targets.map((target) => target.path));
  const out: BehavioralDescription[] = [];
  for (const file of json.files ?? []) {
    const path = typeof file.path === "string" ? file.path : "";
    if (!known.has(path)) continue;
    for (const change of file.changes ?? []) {
      if (typeof change.before !== "string" || typeof change.after !== "string") continue;
      out.push({ path, hunk: typeof change.hunk === "string" ? change.hunk : "", before: change.before, after: change.after });
    }
  }
  return out;
}

export function behavioralJudgmentPrompt(descriptions: BehavioralDescription[], targets: BehavioralTarget[], knownFeatureNames: string[], change: ChangeContext, language: OutputLanguage = "zh-CN"): string {
  const names = knownFeatureNames.map((name) => name.trim()).filter(Boolean).slice(0, 60);
  const contextHeader = (startLine: number, endLine: number) =>
    language === "en" ? `[Changed-region context ${startLine}-${endLine} (with line numbers)]` : `【变更区上下文 ${startLine}-${endLine}（带行号）】`;
  const sections = targets.map((target) => {
    const blocks = target.contextBlocks
      .map((block) => `${contextHeader(block.startLine, block.endLine)}\n${block.content}`)
      .join("\n");
    const targetDescriptions = descriptions_filter(descriptions, target.path, language);
    const restatementHeader = language === "en" ? "[Per-block before/after restatements]" : "【逐块改前/改后复述】";
    return `--- ${language === "en" ? "File" : "文件"}：${target.path} ---\n${restatementHeader}\n${targetDescriptions}\n${blocks}`;
  });
  if (language === "en") {
    return [
      "You are maintaining a product knowledge base. Below are before/after restatements of every changed block in this batch of files, with the corresponding context code.",
      "Judge every restatement explicitly and handle it; none may be skipped:",
      "- The behavior change described is visible to an external observer (new/changed parameters, responses, permission boundaries, configuration options, error paths, retry/skip and other control-flow changes) → output the corresponding scenario; give evidence with precise path:startLine (line numbers taken from the context code).",
      "- Skip a scenario only when you can clearly assert the change is completely invisible to any external observer; when unsure → output the scenario (one extra entry is better than one missed).",
      "- Entries judged to be internal implementation → output a kind=reviewed change (with evidence) to keep the completeness trail.",
      "Organize the spec by features; every scenario contains a context, an action and an outcome, classified happy/edge/error, with references HP-n/EC-n/ER-n. JSON field names must match the template below verbatim (context/action/outcome); never use synonym keys such as result.",
      "Scenarios may carry an optional step: happy scenarios are numbered step=1..N in delivery order (within one feature and one context); an edge/error scenario's step is the happy step it branches from; omit step when the order is unclear and never invent one.",
      "Mind control-flow semantics: an error swallowed by try/except(pass) no longer propagates — the behavior description must reflect the modified externally visible result (e.g. \"creation no longer fails because of…\"), not restate the caught error as output behavior.",
      names.length > 0 ? `Prefer reusing these existing feature names (scenarios belonging to one product capability go into one feature): ${names.join(", ")}` : "Group scenarios belonging to one product capability under one feature name.",
      "Return JSON only, no Markdown. Structure:",
      ANALYSIS_JSON_TEMPLATE,
      `\n[Commit]\n${change.message}`,
      "\n[Changed files (restatements and context)]\n" + sections.join("\n"),
    ].join("\n");
  }
  return [
    "你在维护一个产品知识库。以下是对本批次文件每个变更块的改前/改后复述与对应上下文代码。",
    "对每条复述显式判定并处理，不得遗漏任何一条：",
    "- 复述描述的行为变化对外部观察者可见（新/变参数、新/变响应、新/变权限边界、新配置项、错误路径变化、重试/跳过等控制流变化）→ 输出对应场景；证据给出精确 path:startLine（行号取自上下文代码）。",
    "- 只有当你能明确断言该变更对任何外部观察者完全不可见时才不输出场景；拿不准 → 一律输出场景（宁可多写一条，不可漏写一条）。",
    "- 判为内部实现的条目 → 在 changes 里输出 kind=reviewed 的条目（附证据），保持完整性留痕。",
    "规格按功能组织，每个场景包含情境、操作、结果，分类为 happy/edge/error，reference 使用 HP-n/EC-n/ER-n。JSON 字段名必须与下方模板逐字一致：情境=context、操作=action、结果=outcome，禁止用 result 等同义键名。",
    "场景可选标注 step：happy 场景按交付顺序标 step=1..N（同一功能同一情境内）；edge/error 场景的 step=其分支自的 happy 步骤号；不确定顺序时不写 step，不得编造。",
    "注意控制流语义：try/except(pass) 等被捕获的错误意味着该错误不再向上抛出——行为描述必须反映修改后的外部可见结果（如「创建不再因…而失败」），而不是把被捕获的错误写成输出行为。",
    names.length > 0 ? `功能名优先复用以下既有功能名（同属一个产品功能的场景归入同一功能）：${names.join("、")}` : "将同属一个产品功能的场景归入同一功能名。",
    "只返回 JSON，不要 Markdown。结构：",
    ANALYSIS_JSON_TEMPLATE,
    `\n【本次提交】\n${change.message}`,
    "\n【变更文件（复述与上下文）】\n" + sections.join("\n"),
  ].join("\n");
}

// 判定 prompt 内按文件取复述的辅助（避免闭包序列化问题）
function descriptions_filter(descriptions: BehavioralDescription[], path: string, language: OutputLanguage = "zh-CN"): string {
  const lines = descriptions
    .filter((d) => d.path === path)
    .map((d) => language === "en"
      ? `- Block ${d.hunk || "?"}: before: ${d.before}; after: ${d.after}`
      : `- 块 ${d.hunk || "?"}：改前：${d.before}；改后：${d.after}`);
  if (lines.length > 0) return lines.join("\n");
  return language === "en"
    ? "(No per-block restatements for this file; check the diff and context directly)"
    : "（本文件无逐块复述，直接核对 diff 与上下文）";
}

/**
 * 调用模型的方式。客户端分析注入自己的模型客户端（服务端出口一个字节都不走），并要求提示词带上「不输出源码」的约束；
 * 托管分析什么都不传。
 */
export interface ModelCallOptions {
  client?: StructuredCompletionClient;
  noSourceOutput?: boolean;
}

/** 两个调用出口里选一个：注入了客户端就走它，否则走服务端出口。 */
function completionOf(billing: LlmBillingContext | undefined, options: ModelCallOptions): (messages: Array<{ role: string; content: string }>) => Promise<string> {
  return options.client ? (messages) => options.client!.complete(messages) : (messages) => requestStructuredCompletion(messages, billing);
}

export async function analyzeBehavioralGroup(targets: BehavioralTarget[], knownFeatureNames: string[], change: ChangeContext, billing?: LlmBillingContext, language: OutputLanguage = "zh-CN", options: ModelCallOptions = {}): Promise<AnalysisResult> {
  const complete = completionOf(billing, options);
  // 第一步·复述：每个变更块的改前/改后（机械任务，不做显著性判断）
  const describeContent = await complete(
    [
      { role: "system", content: systemPrompt(language) },
      { role: "user", content: withNoSourceOutput(behavioralDescribePrompt(targets, change, language), language, options.noSourceOutput) },
    ],
  );
  const descriptions = parseBehavioralDescriptions(describeContent, targets);
  // 第二步·判定：对每条复述显式分类（宁多勿漏；内部实现 → reviewed 留痕）
  const judgePrompt = behavioralJudgmentPrompt(descriptions, targets, knownFeatureNames, change, language);
  const content = await complete(
    [
      { role: "system", content: systemPrompt(language) },
      { role: "user", content: withNoSourceOutput(judgePrompt, language, options.noSourceOutput) },
    ],
  );
  return parseBehavioralContent(content, targets);
}

/**
 * 定向枚举的宽容解析：product/release 允许缺省（注入占位——合并层只取分区首趟的
 * product/release，占位不会进规格），features 允许为空（「无行为变化」是合法回答）。
 */
export function parseBehavioralContent(content: string, targets: BehavioralTarget[]): AnalysisResult {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0) throw new Error("AI response did not contain a JSON object");
  const json = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  const emptyProduct = !json.product || typeof json.product !== "object" || !(json.product as { description?: unknown }).description;
  if (emptyProduct) {
    json.product = {
      description: `行为面枚举补充：${targets.map((t) => t.path).join("、")}`,
      evidence: targets.slice(0, 5).map((t) => ({ path: t.path, startLine: t.contextBlocks[0]?.startLine ?? 1 })),
    };
  }
  if (!json.release || typeof json.release !== "object") json.release = { title: "行为面枚举", summary: "行为面枚举补充（合并层只取分区首趟的 release，占位不进规格）。" };
  if (!Array.isArray(json.features)) json.features = [];
  if (!Array.isArray(json.changes)) json.changes = [];
  const behavioralSchema = analysisSchema.extend({ features: z.array(analysisSchema.shape.features.element).max(50) });
  return behavioralSchema.parse(capEvidence(normalizeScenarioAliases(json)));
}

function isAbortTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
