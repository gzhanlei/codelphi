import { evidenceItems } from "./evidence";
import { requestStructuredCompletion } from "./ai";
import type { FeatureRow, ScenarioRow } from "./types";

/**
 * Task 0：AI 提出项目专属业务分组候选（只读面）。
 * 候选来自产品自己的说明、功能、场景与证据，不设跨项目分类模板、不写 parent_id；
 * 只有项目维护者审核通过并经 Task 3 迁移脚本落地后才会影响首页。
 */

export interface DomainCandidateInput {
  name: string;
  description: string;
  features: Pick<FeatureRow, "id" | "name" | "summary" | "parentId">[];
  scenarios: Pick<ScenarioRow, "featureId" | "context" | "action" | "outcome" | "evidence">[];
}

export interface DomainCandidate {
  name: string;
  summary: string;
  /** 只含产品里真实存在的功能 ID；未知 ID 记入 unknowns，不静默丢弃。 */
  featureIds: number[];
  /** 引用功能的场景证据路径（供审核者判断归属依据）；全部缺失时记 unknowns: "evidence-missing"。 */
  evidencePaths: string[];
  unknowns: Array<number | "empty" | "evidence-missing">;
  /** 候选一律是 AI 生成，未核实；确认后经迁移脚本落库才转为 manual 父节点。 */
  source: "generated";
}

export interface DomainCandidateResult {
  candidates: DomainCandidate[];
  error: string | null;
}

/** 候选数量不设预算（2026-11-17 用户拍板：跑出来多少就是多少）；空数组仍视为无有效候选。 */
function toFeatureId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  // 模型键漂移防御：ID 输出成数字字符串（"79"）时在解析层容错，不整批丢弃。
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function buildDomainCandidatePrompt(product: DomainCandidateInput): Array<{ role: "system" | "user"; content: string }> {
  const featureLines = product.features
    .map((feature) => {
      const scenarios = product.scenarios.filter((scenario) => scenario.featureId === feature.id);
      const scenarioText = scenarios.map((scenario) => `${scenario.context}/${scenario.action}/${scenario.outcome}`).join("；");
      return `- [${feature.id}] ${feature.name}：${feature.summary}${scenarioText ? `（场景：${scenarioText}）` : "（无场景）"}`;
    })
    .join("\n");
  return [
    {
      role: "system",
      content:
        "你是产品规格整理助手。根据给定产品自己的说明、功能与场景，提出「业务域」候选：每个业务域是一组面向用户价值的功能归属（如某来源的沟通、某类认知、某类管理），不是技术架构分层。数量按产品实际业务结构决定，不设固定额度；宁可合并成少数几个有分量的域，不要碎片化。只输出 JSON 数组，每项形如 {\"name\":\"业务域名\",\"summary\":\"一句话用户价值\",\"featureIds\":[功能ID]}，featureIds 只能使用输入中列出的功能 ID（数字），每个功能最多归属一个业务域，允许部分功能不归属任何业务域。不要输出 JSON 之外的任何文字。",
    },
    {
      role: "user",
      content: `产品：${product.name}\n说明：${product.description || "（无）"}\n功能与场景：\n${featureLines}`,
    },
  ];
}

/** 解析 AI 输出：未知 ID/空归属/证据缺失都进 unknowns 诚实上报，不激活分组。 */
export function parseDomainCandidates(content: string, features: DomainCandidateInput["features"], scenarios: DomainCandidateInput["scenarios"]): DomainCandidate[] {
  let parsed: unknown;
  try {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start < 0 || end <= start) throw new Error("no JSON array");
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const knownIds = new Set(features.map((feature) => feature.id));
  const evidencePathsByFeature = new Map<number, string[]>(
    features.map((feature) => [
      feature.id,
      [...new Set(scenarios.filter((scenario) => scenario.featureId === feature.id).flatMap((scenario) => evidenceItems(scenario.evidence).map((item) => String(item.path ?? "")).filter(Boolean)))],
    ]),
  );
  const raw = parsed.filter((item): item is { name: unknown; summary: unknown; featureIds: unknown } =>
    typeof item === "object" && item !== null && "name" in item && "featureIds" in item,
  );
  if (raw.length === 0) return [];
  const candidates: DomainCandidate[] = [];
  for (const item of raw) {
    if (typeof item.name !== "string" || item.name.trim().length === 0) return [];
    const requestedIds = (Array.isArray(item.featureIds) ? item.featureIds : []).map(toFeatureId).filter((id): id is number => id !== null);
    const dedupedIds = [...new Set(requestedIds)];
    const unknowns: DomainCandidate["unknowns"] = dedupedIds.filter((id) => !knownIds.has(id));
    const featureIds = dedupedIds.filter((id) => knownIds.has(id));
    if (featureIds.length === 0) unknowns.push("empty");
    const evidencePaths = [...new Set(featureIds.flatMap((id) => evidencePathsByFeature.get(id) ?? []))];
    if (featureIds.length > 0 && evidencePaths.length === 0) unknowns.push("evidence-missing");
    candidates.push({
      name: item.name.trim(),
      summary: typeof item.summary === "string" ? item.summary.trim() : "",
      featureIds,
      evidencePaths,
      unknowns,
      source: "generated",
    });
  }
  return candidates;
}

export async function generateDomainCandidates(product: DomainCandidateInput, options: { requestCompletion?: typeof requestStructuredCompletion } = {}): Promise<DomainCandidateResult> {
  try {
    const completion = options.requestCompletion ?? requestStructuredCompletion;
    const content = await completion(buildDomainCandidatePrompt(product));
    const candidates = parseDomainCandidates(content, product.features, product.scenarios);
    if (candidates.length === 0) return { candidates: [], error: "AI 输出无法解析为有效候选（需要至少一个带有效功能归属的候选），未做任何修改。" };
    return { candidates, error: null };
  } catch (error) {
    return { candidates: [], error: error instanceof Error ? error.message : "候选生成失败" };
  }
}

// ── 分批生成 + 全局合成（2026-11-17：codelphi 153 功能超单次生成规模，单次只出 2 巨域） ──
// 合成步 AI 只输出「哪些子候选合成一组」（引用索引）；featureIds 由程序拼接，
// 功能 ID 全程不经过 AI，防键漂移。未进任何组的子候选保持独立成域（不丢归属）。

export interface MergedDomain {
  name: string;
  summary: string;
  featureIds: number[];
}

export function buildDomainMergePrompt(productName: string, subCandidates: DomainCandidate[]): Array<{ role: "system" | "user"; content: string }> {
  const listing = subCandidates
    .map((candidate, index) => `- [${index}] ${candidate.name}（${candidate.featureIds.length} 个功能）：${candidate.summary}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "你是产品规格整理助手。下面是对某产品分批提取出的业务域子候选。请把它们合并成面向用户价值的最终业务域：把属于同一用户价值的子候选合成一组，已经是独立价值的保持独立。只输出 JSON 数组，每项形如 {\"name\":\"最终域名\",\"summary\":\"一句话用户价值\",\"groups\":[子候选索引]}；groups 只能引用给出的索引，每个索引最多出现一次，允许某些子候选不出现在任何 groups 里（它们将保持独立成域）。不要输出 JSON 之外的任何文字。",
    },
    { role: "user", content: `产品：${productName}\n子候选清单：\n${listing}` },
  ];
}

export function parseDomainMerge(content: string, subCandidates: DomainCandidate[]): { domains: MergedDomain[]; errors: string[] } {
  let parsed: unknown;
  try {
    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start < 0 || end <= start) throw new Error("no JSON array");
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return { domains: [], errors: ["合成输出无法解析为 JSON 数组"] };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return { domains: [], errors: ["合成输出为空"] };
  const errors: string[] = [];
  const used = new Set<number>();
  const seenNames = new Set<string>();
  const domains: MergedDomain[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || typeof (item as { name?: unknown }).name !== "string" || (item as { name: string }).name.trim() === "") {
      errors.push("合成项缺少名称");
      continue;
    }
    const name = ((item as { name: string }).name).trim();
    if (seenNames.has(name)) errors.push(`最终域名「${name}」重复`);
    seenNames.add(name);
    const groups = (item as { groups?: unknown }).groups;
    if (!Array.isArray(groups) || groups.length === 0 || !groups.every((index) => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < subCandidates.length)) {
      errors.push(`「${name}」的 groups 必须是非空且在范围内的整数索引数组`);
      continue;
    }
    for (const index of groups as number[]) {
      if (used.has(index)) errors.push(`子候选 [${index}] 被多个最终域引用`);
      used.add(index);
    }
    const featureIds = [...new Set((groups as number[]).flatMap((index) => subCandidates[index].featureIds))];
    domains.push({ name, summary: typeof (item as { summary?: unknown }).summary === "string" ? ((item as { summary: string }).summary).trim() : "", featureIds });
  }
  if (errors.length > 0) return { domains: [], errors };
  // 未被合并的子候选独立成域（保留原归属，不静默丢弃）
  for (const [index, candidate] of subCandidates.entries()) {
    if (!used.has(index) && !seenNames.has(candidate.name)) domains.push({ name: candidate.name, summary: candidate.summary, featureIds: candidate.featureIds });
  }
  return { domains, errors: [] };
}
