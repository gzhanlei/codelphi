import { z } from "zod";
import { defaultExecute, type Execute } from "./db";
import { evidenceUrl } from "./evidence-url";
import { searchSpec, type SpecSearchResult } from "./spec-search";
import { loadLatestVerificationSpec } from "./spec-verification";
import { stripScenarioRefs } from "./release-notes-enhance";
import type { Evidence } from "./types";

/** B2.1：答案就是规格原文。未覆盖状态在类型上不可能携带结果。 */
export type SpecAnswer =
  | { status: "matched"; question: string; terms: string[]; features: SpecSearchResult["features"]; scenarios: SpecSearchResult["scenarios"]; notice: string }
  | { status: "uncovered"; question: string; terms: string[]; features: []; scenarios: []; notice: string };


// ── B2.2 AI 综合回答（真实使用反馈 2026-11-12：命中后倒出原文卡不是答案）──────
// 只基于命中条目成文；不可回答时如实 answerable:false（拒答机制与 B2.1 未覆盖一致）。
// 卡片始终随响应返回作溯源；AI 失败时 aiAnswer 缺省，前端回退为纯卡片展示。

export interface SpecAnswerSynthesis {
  answer: string;
  used: Array<{ kind: "feature" | "scenario"; id: number }>;
}

const synthesisSchema = z.object({
  answerable: z.boolean(),
  answer: z.string().max(800).default(""),
  used: z.array(z.object({ kind: z.enum(["feature", "scenario"]), id: z.number().int() })).max(16).default([]),
});

export function buildAnswerSynthesisPrompt(input: {
  question: string;
  specVersionId: number | null;
  features: Array<{ id: number; name: string; summary: string }>;
  scenarios: Array<{ id: number; featureName: string; reference: string; context: string; action: string; outcome: string }>;
}): string {
  const featureLines = input.features.map((feature) => `- [功能 #${feature.id}] ${feature.name}：${feature.summary}`);
  const scenarioLines = input.scenarios.map((scenario) => `- [场景 #${scenario.id}] ${scenario.featureName} · ${scenario.reference}：${scenario.context} → ${scenario.action} → ${scenario.outcome}`);
  return [
    "基于下面的产品规格条目回答用户问题。用简体中文。",
    "硬规则：",
    "1. 只使用条目里的事实；条目不足以回答时，返回 answerable:false 并给出 reason（说明规格缺哪部分），不要猜测。",
    "2. 回答 1-3 句、不超过 200 字；直接回答问题本身（用户能得到什么/怎么工作/限制是什么）。",
    "3. 每个用到的条目在 used 里登记（kind=feature 或 scenario，id 用条目标注的编号）。",
    "4. 禁止出现 EC-n/ER-n/HP-n 场景编号与内部术语；条目编号（#数字）只在 used 里登记，不写进正文。",
    '只返回 JSON：{"answerable":true,"answer":"...","used":[{"kind":"feature","id":0}]}',
    "",
    `【用户问题】${input.question}`,
    input.specVersionId !== null ? `【规格版本】v${input.specVersionId}` : "",
    "",
    "【规格条目】",
    ...featureLines,
    ...scenarioLines,
  ].join("\n");
}

export interface ParsedSpecAnswerSynthesis {
  answerable: boolean;
  answer: string;
  used: Array<{ kind: "feature" | "scenario"; id: number }>;
}

export function parseAnswerSynthesis(content: string): ParsedSpecAnswerSynthesis {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 输出不含 JSON 结构");
  const parsed = synthesisSchema.safeParse(JSON.parse(stripped.slice(start, end + 1)));
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "结构不合格");
  if (!parsed.data.answerable || !parsed.data.answer.trim()) return { answerable: false, answer: "", used: [] };
  return { answerable: true, answer: stripScenarioRefs(parsed.data.answer.trim()), used: parsed.data.used };
}


// ── B2.2b 词汇鸿沟兜底：词法检索未命中 ≠ 规格没答案（例：问『语言』，条目写的是 Next.js/Go）。
// 一次 AI 调用从功能清单选出相关功能，再走既有综合链路。宁缺毋滥：无相关功能如实返回空。

const featureSelectSchema = z.object({ relevant: z.array(z.number().int()).max(10).default([]) });

export function buildFeatureSelectPrompt(input: { question: string; catalog: Array<{ id: number; name: string; summary: string }> }): string {
  return [
    "用户针对一个产品提问。下面是产品的功能清单（名称：简介）。",
    "任务：判断哪些功能与用户问题相关，返回它们的 id。只基于名称与简介判断，宁缺毋滥——拿不准就不要选；没有任何相关功能时返回空数组。",
    '只返回 JSON：{"relevant":[1,2]}',
    "",
    `【用户问题】${input.question}`,
    "【功能清单】",
    ...input.catalog.map((item) => `- #${item.id} ${item.name}：${item.summary}`),
  ].join("\n");
}

export function parseFeatureSelection(content: string, validIds: ReadonlySet<number>): number[] {
  const stripped = content.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  const parsed = featureSelectSchema.safeParse(JSON.parse(stripped.slice(start, end + 1)));
  if (!parsed.success) return [];
  return parsed.data.relevant.filter((id) => validIds.has(id));
}

export interface QueryTerm {
  value: string;
  /** 英文 / 数字词：单个命中即可作为依据；中文 2-gram 需要两个不同词共同命中。 */
  strong: boolean;
}

const MAX_QUESTION_LENGTH = 200;
const MAX_TERMS = 8;
const MIN_HIT_TERMS = 2;
const MAX_FEATURES = 5;
const MAX_SCENARIOS = 10;

/** 只过滤疑问与语气字；功能词（如「通知」「登录」）必须保留，否则召回会被掏空。 */
const STOP_CHARACTERS = new Set([
  "的", "了", "吗", "呢", "吧", "啊", "是", "我", "你", "他", "它",
  "请", "问", "想", "怎", "么", "什", "多", "少", "几", "能", "会",
  "可", "要", "这", "那", "和", "与", "就", "都", "也", "还", "又",
  "再", "最", "个", "不", "无", "把", "被", "给", "让", "从", "向",
  "以", "为", "之", "其", "该", "此", "很", "太", "更",
]);

const MATCHED_NOTICE = "以下为规格原文摘录，非 AI 生成；点击条目可查看完整功能与代码证据。";
const NOT_COVERED_NOTICE = "当前规格未覆盖此问题，未覆盖部分不产生结论。可换用更贴近功能名称的词，或前往规格页查看。";

/** 纯函数：问句 → 确定性检索词。不调用任何模型，也不产出给用户看的文字。 */
export function buildQueryTerms(question: string): QueryTerm[] {
  const normalized = question.trim().slice(0, MAX_QUESTION_LENGTH);
  if (!normalized) return [];
  const terms: QueryTerm[] = [];
  const seen = new Set<string>();
  const add = (value: string, strong: boolean) => {
    if (value.length < 2 || seen.has(value) || terms.length >= MAX_TERMS) return;
    seen.add(value);
    terms.push({ value, strong });
  };
  for (const match of normalized.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]*/g)) {
    if (match[0].length >= 2) add(match[0], true);
  }
  for (const chunk of normalized.split(/[^\u4e00-\u9fa5]+/)) {
    for (let index = 0; index + 2 <= chunk.length; index += 1) {
      const gram = chunk.slice(index, index + 2);
      if ([...gram].some((character) => STOP_CHARACTERS.has(character))) continue;
      add(gram, false);
    }
  }
  return terms;
}

type Hit<T> = { item: T; terms: Set<string>; strong: boolean };
type Hits<T> = Map<number, Hit<T>>;

function accumulate<T>(hits: Hits<T>, rows: T[], idOf: (row: T) => number, term: QueryTerm): void {
  for (const row of rows) {
    const id = idOf(row);
    const hit = hits.get(id) ?? { item: row, terms: new Set<string>(), strong: false };
    hit.terms.add(term.value);
    if (term.strong) hit.strong = true;
    hits.set(id, hit);
  }
}

function eligible<T>(hit: Hit<T>): boolean {
  return hit.strong || hit.terms.size >= MIN_HIT_TERMS;
}

/** 纯函数：按命中词数排序，保证同一输入两次调用结果一致。 */
function finalize<T>(hits: Hits<T>, limit: number): T[] {
  return [...hits.entries()]
    .filter(([, hit]) => eligible(hit))
    .sort(([aId, a], [bId, b]) => b.terms.size - a.terms.size || Number(b.strong) - Number(a.strong) || aId - bId)
    .slice(0, limit)
    .map(([, hit]) => hit.item);
}

/** IO 编排：逐词复用现有 searchSpec，业务逻辑全在上面的纯函数里。 */
export async function answerSpecQuestion(productId: number, question: string, execute: Execute = defaultExecute): Promise<SpecAnswer> {
  const normalized = question.trim().slice(0, MAX_QUESTION_LENGTH);
  const terms = buildQueryTerms(normalized);
  const labels = terms.map((term) => term.value);
  if (terms.length === 0) {
    return { status: "uncovered", question: normalized, terms: labels, features: [], scenarios: [], notice: NOT_COVERED_NOTICE };
  }
  const features: Hits<SpecSearchResult["features"][number]> = new Map();
  const scenarios: Hits<SpecSearchResult["scenarios"][number]> = new Map();
  for (const term of terms) {
    const result = await searchSpec(productId, term.value, execute);
    accumulate(features, result.features, (feature) => feature.id, term);
    accumulate(scenarios, result.scenarios, (scenario) => scenario.id, term);
  }
  const matchedFeatures = finalize(features, MAX_FEATURES);
  const matchedScenarios = finalize(scenarios, MAX_SCENARIOS);
  if (matchedFeatures.length === 0 && matchedScenarios.length === 0) {
    return { status: "uncovered", question: normalized, terms: labels, features: [], scenarios: [], notice: NOT_COVERED_NOTICE };
  }
  return { status: "matched", question: normalized, terms: labels, features: matchedFeatures, scenarios: matchedScenarios, notice: MATCHED_NOTICE };
}

export interface SpecAnswerContext {
  specVersionId: number | null;
  repo: { owner: string; name: string } | null;
  sha: string | null;
}

export type DecoratedSpecAnswer = SpecAnswer & {
  specVersionId: number | null;
  /** B2.2：AI 综合回答（只基于命中条目成文，带 used 锚点）；缺省 = 前端回退为纯卡片。 */
  aiAnswer?: { answer: string; used: Array<{ kind: "feature" | "scenario"; id: number }> } | null;
};

/** IO：答案所属的规格版本，以及把证据变成 blob 链接所需的仓库坐标。verification loader 可注入，便于在隔离环境中测试。 */
export async function loadSpecAnswerContext(
  productId: number,
  execute: Execute = defaultExecute,
  loadVerification: typeof loadLatestVerificationSpec = loadLatestVerificationSpec,
): Promise<SpecAnswerContext> {
  const spec = await loadVerification(productId, execute);
  const [rows] = await execute(
    "SELECT owner, name FROM repositories WHERE product_id = ? LIMIT 1",
    [productId],
  ) as [Array<{ owner: string; name: string }>, unknown];
  return { specVersionId: spec?.specVersionId ?? null, repo: rows[0] ?? null, sha: spec?.sha ?? null };
}

/** 纯函数：标注规格版本，并给证据补可点击的源码链接（AI 已给 url 的不覆盖）。 */
export function decorateSpecAnswer(answer: SpecAnswer, decoration: SpecAnswerContext): DecoratedSpecAnswer {
  if (answer.status === "uncovered") return { ...answer, specVersionId: decoration.specVersionId };
  const { repo, sha } = decoration;
  if (!repo || !sha) return { ...answer, specVersionId: decoration.specVersionId };
  return {
    ...answer,
    specVersionId: decoration.specVersionId,
    scenarios: answer.scenarios.map((scenario) => ({
      ...scenario,
      evidence: scenario.evidence.map((item: Evidence) => ({ ...item, url: item.url ?? evidenceUrl(repo, sha, item) ?? undefined })),
    })),
  };
}
