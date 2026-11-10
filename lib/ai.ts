import { z } from "zod";
import { requiredEnv } from "./env";
import type { SourceFile } from "./github";
import { recordLlmCallReceipt, type ChargeComponent } from "./billing/cost-receipt";

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
  features: z.array(z.object({
    name: z.string().min(1).max(191),
    summary: z.string().min(1).max(4_000),
    scenarios: z.array(scenarioSchema).max(40),
  })).min(1).max(50),
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
    features?: Array<{ scenarios?: Array<{ evidence?: unknown }>; evidence?: unknown }>;
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
        if (cleaned.outcome !== undefined || typeof cleaned.result !== "string") return cleaned;
        const { result, ...rest } = cleaned;
        return { ...rest, outcome: result };
      }),
    })),
  };
}

export function parseAnalysisContent(content: string): AnalysisResult {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0) throw new Error("AI response did not contain a JSON object");
  const json = trimmed.slice(start, end + 1);
  if (!json.endsWith("}")) throw new Error("AI response did not contain a JSON object");
  return analysisSchema.parse(capEvidence(normalizeScenarioAliases(JSON.parse(json))));
}

export interface ChangeContext {
  message: string;
  files: Array<{ path: string; status: string; patch: string }>;
}

export function chatCompletionsUrl() {
  const configured = (process.env.AI_BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
  if (configured.endsWith("/v1/chat/completions")) return configured;
  if (configured.endsWith("/v1")) return `${configured}/chat/completions`;
  return `${configured}/v1/chat/completions`;
}

const gatewayResponseSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().optional() }).optional() })),
  usage: z.unknown().optional(),
});

export interface GatewayResponse {
  content: string;
  /** 网关原始 usage 对象（结构因 provider 而异，采集期只透传落库）；缺失时为 null。 */
  usage: unknown | null;
  requestId: string | null;
}

export function gatewayResponse(value: unknown): GatewayResponse {
  const data = gatewayResponseSchema.parse(value);
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error("AI gateway returned empty content");
  return {
    content,
    usage: data.usage ?? null,
    requestId: data.id === undefined ? null : String(data.id),
  };
}

async function requireSuccessfulAIResponse(response: Response) {
  if (!response.ok) throw new Error(`AI gateway ${response.status}: ${await response.text()}`);
}

/** B：把上一版功能名清单注入 prompt，约束命名与粒度连续，消除逐次重提取的改名风暴。 */
export function featureContinuitySection(previousFeatureNames?: string[]) {
  const names = (previousFeatureNames ?? []).map((name) => name.trim()).filter(Boolean).slice(0, 60);
  if (names.length === 0) return null;
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
}

export interface SpecAnchorFeature {
  name: string;
  summary: string;
  scenarios: SpecAnchorScenario[];
}

/** P0 措辞锚定：上一版规格的场景级文本，未变行为要求逐字沿用，消除全量重建的改写噪音。 */
export function specAnchoringSection(previousSpec?: SpecAnchorFeature[], maxChars = 24_000) {
  const features = (previousSpec ?? []).filter((feature) => feature.name.trim() && feature.scenarios.length > 0);
  if (features.length === 0) return null;
  const lines: string[] = ["【上一版规格全文——行为未变的条目必须逐字沿用】"];
  let used = 0;
  let truncated = false;
  for (const feature of features) {
    const head = `功能：${feature.name}（简介：${feature.summary}）`;
    const scenarioLines = feature.scenarios.map((scenario) =>
      `- ${scenario.reference}｜${scenario.category}｜情境：${scenario.context}｜操作：${scenario.action}｜结果：${scenario.outcome}`,
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
    "功能简介同样逐字沿用：只要一个功能的场景集没有变化，简介必须与上一版完全一致，禁止改写、扩写、增删例举或调整措辞；简介只能随场景的真实增删改一并修订。",
  ].join("\n");
}

/** M9 增量模式：约束 AI 只输出被触及的功能，其余由系统沿用上一版。 */
export function incrementalScopeSection(affectedFeatureNames?: string[]) {
  if (!affectedFeatureNames || affectedFeatureNames.length === 0) return null;
  return [
    "【增量分析模式】",
    "本次只深入分析以下功能（这些功能的代码被本次提交触及）：",
    ...affectedFeatureNames.map((name) => `- ${name}`),
    "features 数组必须且只能包含上述功能；其余功能由系统沿用上一版规格，请勿输出。",
    "对上述每个功能，输出其当前行为的完整清单，覆盖程度与全量分析相当（通常每功能 3-8 个场景），happy/edge/error 全部类别逐一检查，边界与错误路径不得省略。",
    "product 简介与 release 变化仍需覆盖整个提交的内容。",
  ].join("\n");
}

export interface LlmBillingContext {
  runId: number;
  accountId: number | null;
  chargeComponent: ChargeComponent;
}

export async function analyzeWithAI(sources: SourceFile[], change: ChangeContext, context: { previousFeatureNames?: string[]; previousSpec?: SpecAnchorFeature[]; affectedFeatureNames?: string[]; partition?: { index: number; total: number }; billing?: LlmBillingContext } = {}): Promise<AnalysisResult> {
  const anchor = specAnchoringSection(context.previousSpec);
  const continuity = anchor ? null : featureContinuitySection(context.previousFeatureNames);
  const scope = incrementalScopeSection(context.affectedFeatureNames);
  const partition = context.partition;
  const partitionSection = partition
    ? `\n【分区提取】\n本窗口是代码库的第 ${partition.index}/${partition.total} 个分区，只包含代码库的一部分。其他分区由独立提取负责，合并层会统一去重与归并：只需覆盖本窗口内的全部主要用户功能，不要猜测窗口外的模块，也不要输出「其他功能见其他分区」之类的占位条目。`
    : null;
  const coverageMandate = partition
    ? "当前产品功能规格必须覆盖本窗口代码里的全部主要用户功能。逐个检查输入中的页面、API、组件和业务模块；输入包含多个独立模块时，只返回一个功能属于不完整结果。"
    : "当前产品功能规格必须覆盖输入代码里的全部主要用户功能，不得只总结本次提交。逐个检查输入中的页面、API、组件和业务模块；输入包含多个独立模块时，只返回一个功能属于不完整结果。";
  const prompt = [
    "你在维护一个产品知识库。仅根据给定代码和 diff 输出事实，不要补充猜测。",
    "用简体中文生成：1) 产品简介；2) 当前产品功能规格；3) 本次发布的用户可感知变化。",
    "产品简介用一到两句话说明服务对象和核心能力，不超过 200 字，必须概括整个代码库而不是本次提交，并给出输入文件中的 evidence；不要只写产品名或营销词。",
    "规格按功能组织，每个场景包含情境、操作、结果，分类为 happy/edge/error，reference 使用 HP-n/EC-n/ER-n。JSON 字段名必须与下方模板逐字一致：情境=context、操作=action、结果=outcome，禁止用 result 等同义键名。",
    coverageMandate,
    "优先保证功能覆盖，每个功能保留最关键的 1-5 个场景；不要因单个功能场景过多而遗漏其他功能。",
    "每个场景、变化和产品简介必须给 evidence；path 必须来自输入文件，startLine 使用输入的行号。没有用户变化的发布只生成 reviewed 项。",
    "只返回 JSON，不要 Markdown。结构：",
    '{"product":{"description":"","evidence":[{"path":"","startLine":1}]},"release":{"title":"","summary":""},"changes":[{"featureName":"","kind":"added|changed|removed|fixed|reviewed","description":"","userImpact":"","evidence":[{"path":"","startLine":1}]}],"features":[{"name":"","summary":"","scenarios":[{"reference":"HP-1","context":"","action":"","outcome":"","category":"happy","evidence":[{"path":"","startLine":1}]}]}]}',
    ...(anchor ? [anchor] : []),
    ...(continuity ? [continuity] : []),
    ...(scope ? [scope] : []),
    ...(partitionSection ? [partitionSection] : []),
    `\n【本次提交】\n${change.message}\n\n【文件变化】\n${JSON.stringify(change.files)}`,
    `\n【当前代码，带行号】\n${sources.map((file) => `\n--- ${file.path} ---\n${file.content}`).join("\n")}`,
  ].join("\n");

  const content = await requestStructuredCompletion(
    [
      { role: "system", content: "你是严谨的代码分析器，只输出可验证的结构化事实。" },
      { role: "user", content: prompt },
    ],
    context.billing,
  );
  return parseAnalysisContent(content);
}

/**
 * 网关调用 + 回执记账的共享体（契约 M0-T2：超时与失败都落一条 unknown-usage 记录，
 * 网关 2xx 但结构不可解析时 usage 若存在仍落库）。供标准提取与 W0-8 定向枚举共用。
 */
async function requestStructuredCompletion(messages: Array<{ role: string; content: string }>, billing?: LlmBillingContext): Promise<string> {
  const model = requiredEnv("AI_MODEL");
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
    if (billing) {
      await recordLlmCallReceipt({
        runId: billing.runId,
        accountId: billing.accountId,
        chargeComponent: billing.chargeComponent,
        model,
        outcome: isAbortTimeout(error) ? "timeout" : "failed",
        usageRaw: null,
        providerRequestId: null,
      });
    }
    throw error;
  }
  if (!response.ok) {
    if (billing) {
      await recordLlmCallReceipt({
        runId: billing.runId,
        accountId: billing.accountId,
        chargeComponent: billing.chargeComponent,
        model,
        outcome: "failed",
        usageRaw: null,
        providerRequestId: null,
      });
    }
    await requireSuccessfulAIResponse(response);
  }
  const payload: unknown = await response.json();
  let content: string;
  let usage: unknown | null;
  let requestId: string | null;
  try {
    ({ content, usage, requestId } = gatewayResponse(payload));
  } catch (error) {
    // 网关返回 2xx 但结构不可解析：usage 若存在仍要落库（成本已发生）
    if (billing) {
      const payloadRecord = payload as { usage?: unknown } | null;
      await recordLlmCallReceipt({
        runId: billing.runId,
        accountId: billing.accountId,
        chargeComponent: billing.chargeComponent,
        model,
        outcome: "failed",
        usageRaw: payloadRecord?.usage ?? null,
        providerRequestId: null,
      });
    }
    throw error;
  }
  if (billing) {
    await recordLlmCallReceipt({
      runId: billing.runId,
      accountId: billing.accountId,
      chargeComponent: billing.chargeComponent,
      model,
      outcome: "success",
      usageRaw: usage,
      providerRequestId: requestId,
    });
  }
  return content;
}

/** W0-8 行为面枚举：逐文件显式提问的定向提取（小 prompt、强制逐文件回答）。 */
export interface BehavioralTarget {
  path: string;
  /** 该文件在本窗口的 unified diff patch。 */
  patch: string;
  /** 变更区上下文（带行号的代码行）。 */
  contextBlocks: Array<{ startLine: number; endLine: number; content: string }>;
}

export function behavioralEnumerationPrompt(targets: BehavioralTarget[], knownFeatureNames: string[], change: ChangeContext): string {
  const names = knownFeatureNames.map((name) => name.trim()).filter(Boolean).slice(0, 60);
  const sections = targets.map((target) => {
    const blocks = target.contextBlocks
      .map((block) => `【变更区上下文 ${block.startLine}-${block.endLine}（带行号）】\n${block.content}`)
      .join("\n");
    return `--- 文件：${target.path} ---\n【变更 diff】\n${target.patch || "（无 patch）"}\n${blocks}`;
  });
  return [
    "你在维护一个产品知识库。仅根据给定代码和 diff 输出事实，不要补充猜测。",
    "【定向行为枚举】",
    `以下是本批次 ${targets.length} 个文件在本窗口的变更 diff 与变更区上下文代码。对每个文件逐一核对其变更块：`,
    "- 文件的修改引入或改变了用户可感知的行为（新/变参数、新/变响应、新/变权限边界、新配置项、错误路径变化、重试/跳过等控制流变化）→ 输出对应场景；证据必须给出精确 path:startLine（行号取自上下文代码）。",
    "- 该文件的修改没有用户可感知行为变化（纯重构/注释/样式/内部实现调整）→ 不要为它输出场景。",
    "逐个文件显式核对，不得遗漏任何一个文件；也不要为本批次之外的文件输出场景。",
    "注意控制流语义：try/except(pass) 等被捕获的错误意味着该错误不再向上抛出——行为描述必须反映修改后的外部可见结果（如「创建不再因…而失败」），而不是把被捕获的错误写成输出行为。",
    "规格按功能组织，每个场景包含情境、操作、结果，分类为 happy/edge/error，reference 使用 HP-n/EC-n/ER-n。JSON 字段名必须与下方模板逐字一致：情境=context、操作=action、结果=outcome，禁止用 result 等同义键名。",
    names.length > 0 ? `功能名优先复用以下既有功能名（同属一个产品功能的场景归入同一功能）：${names.join("、")}` : "将同属一个产品功能的场景归入同一功能名。",

    "只返回 JSON，不要 Markdown。结构：",
    '{"product":{"description":"","evidence":[{"path":"","startLine":1}]},"release":{"title":"","summary":""},"changes":[{"featureName":"","kind":"added|changed|removed|fixed|reviewed","description":"","userImpact":"","evidence":[{"path":"","startLine":1}]}],"features":[{"name":"","summary":"","scenarios":[{"reference":"HP-1","context":"","action":"","outcome":"","category":"happy","evidence":[{"path":"","startLine":1}]}]}]}',
    `\n【本次提交】\n${change.message}\n\n【文件变化】\n${JSON.stringify(change.files)}`,
    "\n【变更文件（逐文件 diff 与变更区上下文）】\n" + sections.join("\n"),
  ].join("\n");
}

export async function analyzeBehavioralGroup(targets: BehavioralTarget[], knownFeatureNames: string[], change: ChangeContext, billing?: LlmBillingContext): Promise<AnalysisResult> {
  const prompt = behavioralEnumerationPrompt(targets, knownFeatureNames, change);
  const content = await requestStructuredCompletion(
    [
      { role: "system", content: "你是严谨的代码分析器，只输出可验证的结构化事实。" },
      { role: "user", content: prompt },
    ],
    billing,
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
