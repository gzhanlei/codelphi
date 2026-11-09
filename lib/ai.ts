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

export function parseAnalysisContent(content: string): AnalysisResult {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0) throw new Error("AI response did not contain a JSON object");
  const json = trimmed.slice(start, end + 1);
  if (!json.endsWith("}")) throw new Error("AI response did not contain a JSON object");
  return analysisSchema.parse(capEvidence(JSON.parse(json)));
}

interface ChangeContext {
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
    "规格按功能组织，每个场景包含情境、操作、结果，分类为 happy/edge/error，reference 使用 HP-n/EC-n/ER-n。",
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

  const model = requiredEnv("AI_MODEL");
  const billing = context.billing;

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
        messages: [
          { role: "system", content: "你是严谨的代码分析器，只输出可验证的结构化事实。" },
          { role: "user", content: prompt },
        ],
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
  return parseAnalysisContent(content);
}

function isAbortTimeout(error: unknown) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
