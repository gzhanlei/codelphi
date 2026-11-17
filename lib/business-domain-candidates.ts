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

const MIN_CANDIDATES = 3;
/** 与通用迁移脚本的 MAX_GENERIC_DOMAINS 对齐（2026-11-17：Chandler 实测自然产出 9 域，8 上限误杀）。 */
const MAX_CANDIDATES = 12;

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
        "你是产品规格整理助手。根据给定产品自己的说明、功能与场景，提出 3-12 个「业务域」候选：每个业务域是一组面向用户价值的功能归属（如某来源的沟通、某类认知、某类管理），不是技术架构分层；宁可合并成少数几个有分量的域，不要碎片化。只输出 JSON 数组，每项形如 {\"name\":\"业务域名\",\"summary\":\"一句话用户价值\",\"featureIds\":[功能ID]}，featureIds 只能使用输入中列出的功能 ID，每个功能最多归属一个业务域，允许部分功能不归属任何业务域。不要输出 JSON 之外的任何文字。",
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
  if (raw.length < MIN_CANDIDATES || raw.length > MAX_CANDIDATES) return [];
  const candidates: DomainCandidate[] = [];
  for (const item of raw) {
    if (typeof item.name !== "string" || item.name.trim().length === 0) return [];
    const requestedIds = Array.isArray(item.featureIds) ? item.featureIds.filter((id): id is number => typeof id === "number") : [];
    const unknowns: DomainCandidate["unknowns"] = requestedIds.filter((id) => !knownIds.has(id));
    const featureIds = requestedIds.filter((id) => knownIds.has(id));
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
    if (candidates.length === 0) return { candidates: [], error: "AI 输出无法解析为有效候选（需 3-8 个带有效功能归属的候选），未做任何修改。" };
    return { candidates, error: null };
  } catch (error) {
    return { candidates: [], error: error instanceof Error ? error.message : "候选生成失败" };
  }
}
