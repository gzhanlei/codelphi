import { z } from "zod";
import type { OutputLanguage } from "../analysis-language";
import type { AnalysisResult } from "../ai";
import type { StructuredCompletionClient } from "../llm-client";
import type { SnapshotCoreCapability, SnapshotConcept, SnapshotJourney, SnapshotPresentation, SnapshotScenarioRef } from "./types";

const scenarioRefSchema = z.object({ featureName: z.string().trim().min(1), reference: z.string().trim().min(1) });

const presentationSchema = z.object({
  tagline: z.string().trim().min(1).max(300),
  coreCapabilities: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(600),
    featureNames: z.array(z.string().trim().min(1)).min(1),
    scenarioRefs: z.array(scenarioRefSchema).max(2),
  })).min(1).max(8),
  journeys: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    steps: z.array(scenarioRefSchema).min(2).max(6),
  })).max(5).default([]),
  concepts: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(600),
    scenarioRefs: z.array(scenarioRefSchema).min(1).transform((refs) => refs.slice(0, 3)),
    relations: z.array(z.object({
      targetName: z.string().trim().min(1),
      summary: z.string().trim().min(1).max(300),
      scenarioRef: scenarioRefSchema,
    })).max(6),
  })).max(12).default([]),
});

function withIds(
  capabilities: Array<Omit<SnapshotCoreCapability, "id">>,
  journeys: Array<Omit<SnapshotJourney, "id" | "evidenceStatus">>,
  concepts: Array<Omit<SnapshotConcept, "id">>,
  status: SnapshotPresentation["status"],
  tagline?: string,
): SnapshotPresentation {
  return {
    status,
    coreCapabilities: capabilities.map((capability, index) => ({ ...capability, id: `capability-${index + 1}` })),
    journeys: journeys.map((journey, index) => ({ ...journey, id: `journey-${index + 1}`, evidenceStatus: "scenario_composition" })),
    concepts: concepts.map((concept, index) => ({ ...concept, id: `concept-${index + 1}` })),
    ...(tagline ? { tagline } : {}),
  };
}

export function fallbackSnapshotPresentation(result: Pick<AnalysisResult, "features">, language: OutputLanguage): SnapshotPresentation {
  return withIds([{
    name: language === "en" ? "Complete feature index" : "完整功能索引",
    summary: language === "en"
      ? "Smart project mapping is unavailable. Use the complete specification and search below; no core-capability ranking is implied."
      : "智能项目地图不可用。请使用下方完整规格与搜索；此处不代表核心能力排序。",
    featureNames: result.features.map((feature) => feature.name),
    scenarioRefs: [],
  }], [], [], "fallback");
}

function parseJson<T>(content: string, schema: z.ZodType<T>): T {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return schema.parse(JSON.parse(trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)));
}

function validatePresentation(presentation: z.infer<typeof presentationSchema>, result: AnalysisResult) {
  const featureByName = new Map(result.features.map((feature) => [feature.name, feature]));
  const validateScenarioRef = (ref: SnapshotScenarioRef, requireHappyPath = false) => {
    const feature = featureByName.get(ref.featureName);
    const scenario = feature?.scenarios.find((candidate) => candidate.reference === ref.reference);
    if (!scenario) throw new Error("Unknown scenario reference in presentation");
    if (requireHappyPath && scenario.category !== "happy") throw new Error("Journey steps must use happy path scenarios");
  };
  const assigned = new Set<string>();
  for (const capability of presentation.coreCapabilities) {
    for (const featureName of capability.featureNames) {
      if (!featureByName.has(featureName) || assigned.has(featureName)) throw new Error("Invalid feature coverage in presentation");
      assigned.add(featureName);
    }
    for (const ref of capability.scenarioRefs) {
      if (!capability.featureNames.includes(ref.featureName)) throw new Error("Scenario reference escapes its capability");
      validateScenarioRef(ref);
    }
  }
  if (assigned.size !== result.features.length) throw new Error("Presentation must cover every existing feature without adding new ones");
  for (const journey of presentation.journeys) {
    if (result.features.length > 1 && new Set(journey.steps.map((step) => step.featureName)).size < 2) throw new Error("Journey must connect at least two features");
    for (const step of journey.steps) validateScenarioRef(step, true);
  }
  const conceptNames = new Set<string>();
  for (const concept of presentation.concepts) {
    if (conceptNames.has(concept.name)) throw new Error("Duplicate concept in presentation");
    conceptNames.add(concept.name);
    for (const ref of concept.scenarioRefs) validateScenarioRef(ref);
  }
  for (const concept of presentation.concepts) {
    for (const relation of concept.relations) {
      if (!conceptNames.has(relation.targetName)) throw new Error("Unknown concept relation in presentation");
      validateScenarioRef(relation.scenarioRef);
    }
  }
  return withIds(presentation.coreCapabilities, presentation.journeys, presentation.concepts, "generated", presentation.tagline);
}

export function parseSnapshotPresentation(content: string, result: AnalysisResult): SnapshotPresentation {
  return validatePresentation(parseJson(content, presentationSchema), result);
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * items.length / limit)]);
}

async function createLargeSnapshotPresentation(options: {
  result: AnalysisResult;
  language: OutputLanguage;
  client: StructuredCompletionClient;
}): Promise<SnapshotPresentation> {
  const languageName = options.language === "en" ? "English" : "Simplified Chinese";
  const planSchema = z.object({
    tagline: z.string().trim().min(1).max(300),
    domains: z.array(z.object({ name: z.string().trim().min(1).max(160), summary: z.string().trim().min(1).max(600) })).min(1).max(8),
  });
  const inventory = options.result.features.map((feature) => ({ name: feature.name, summary: feature.summary }));
  const planPrompt = options.language === "en"
    ? `Create a domain plan for this large evidence-backed product. Do not add facts or claims. Write one plain-language tagline naming the user problem and main product parts without leading with frameworks or implementation jargon. Define 4-8 outcome-oriented product domains that can hold every feature, including technical and operational features; avoid catch-all domains. Do not assign features in this step. Return JSON only with this shape: {"tagline":"","domains":[{"name":"","summary":""}]}.\n\nProduct description: ${options.result.product.description}\n\nDomain plan feature inventory:\n${JSON.stringify(inventory)}`
    : `你在为大型、带证据的产品创建领域计划。不得新增事实或结论。先用一句话 tagline 说明产品解决什么问题、由哪些主要部分组成，避免以框架或实现术语开头。定义 4-8 个面向用户价值的产品领域，能够容纳全部功能，包括技术与运维功能，避免“其他”兜底域。本步不要分配功能。只返回 JSON，结构为：{"tagline":"","domains":[{"name":"","summary":""}]}。\n\n产品简介：${options.result.product.description}\n\nDomain plan feature inventory:\n${JSON.stringify(inventory)}`;
  const plan = parseJson(await options.client.complete([
    { role: "system", content: `You reorganize specifications without adding facts. Use ${languageName} for name and summary fields.` },
    { role: "user", content: planPrompt },
  ]), planSchema);
  const domainNames = new Set(plan.domains.map((domain) => domain.name));
  const assignmentSchema = z.object({ assignments: z.array(z.object({ featureName: z.string().trim().min(1), domainName: z.string().trim().min(1) })).min(1) });
  const batches = Array.from({ length: Math.ceil(options.result.features.length / 50) }, (_, index) => options.result.features.slice(index * 50, index * 50 + 50));
  const batchAssignments: Array<Array<{ featureName: string; domainName: string }>> = new Array(batches.length);
  let batchCursor = 0;
  const assignmentWorker = async () => {
    while (batchCursor < batches.length) {
      const batchIndex = batchCursor++;
      const batch = batches[batchIndex];
      const prompt = options.language === "en"
        ? `Assign every feature in this batch to exactly one existing domain. Do not invent domains or features. Return every input featureName exactly once and use only the listed domainName values. Return JSON only with this shape: {"assignments":[{"featureName":"","domainName":""}]}.\n\nDomains:\n${JSON.stringify(plan.domains)}\n\nFeature assignment batch:\n${JSON.stringify(batch.map((feature) => ({ name: feature.name, summary: feature.summary })))}`
        : `把本批每个功能恰好分配到一个已有领域。不得新增领域或功能。每个输入 featureName 必须恰好出现一次，domainName 只能使用给定值。只返回 JSON，结构为：{"assignments":[{"featureName":"","domainName":""}]}。\n\n领域：\n${JSON.stringify(plan.domains)}\n\nFeature assignment batch:\n${JSON.stringify(batch.map((feature) => ({ name: feature.name, summary: feature.summary })))}`;
      const output = parseJson(await options.client.complete([
        { role: "system", content: `You assign existing specifications to existing domains without adding facts. Use ${languageName}.` },
        { role: "user", content: prompt },
      ]), assignmentSchema);
      const expected = new Set(batch.map((feature) => feature.name));
      const assigned = new Set(output.assignments.map((assignment) => assignment.featureName));
      if (assigned.size !== batch.length || output.assignments.length !== batch.length || [...expected].some((name) => !assigned.has(name)) || output.assignments.some((assignment) => !domainNames.has(assignment.domainName))) throw new Error(`Invalid feature assignment batch ${batchIndex + 1}`);
      batchAssignments[batchIndex] = output.assignments;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, batches.length) }, () => assignmentWorker()));
  const assignments = batchAssignments.flat();
  const grouping = {
    tagline: plan.tagline,
    coreCapabilities: plan.domains.map((domain) => ({
      ...domain,
      featureNames: assignments.filter((assignment) => assignment.domainName === domain.name).map((assignment) => assignment.featureName),
      scenarioRefs: [],
    })).filter((capability) => capability.featureNames.length > 0),
  };

  const featureByName = new Map(options.result.features.map((feature) => [feature.name, feature]));
  const candidates = grouping.coreCapabilities.flatMap((capability) => evenlySample(capability.featureNames, 12).flatMap((featureName) => {
    const feature = featureByName.get(featureName)!;
    const happy = feature.scenarios.filter((scenario) => scenario.category === "happy");
    return (happy.length > 0 ? happy : feature.scenarios).slice(0, 2).map((scenario) => ({
      domain: capability.name,
      featureName,
      reference: scenario.reference,
      context: scenario.context,
      action: scenario.action,
      outcome: scenario.outcome,
    }));
  }));
  const detailSchema = presentationSchema.pick({ journeys: true, concepts: true });
  const detailPrompt = options.language === "en"
    ? `Create the understanding layer for a first-time user using only these existing evidence-backed scenarios. Do not add facts, objects, relations, or claims. Create up to five end-to-end user journeys, each with 2-6 ordered exact scenario steps. Every journey must connect at least two features; do not force one when evidence is insufficient. Prefer product-level goals and cross-module flows over isolated class calls. When alternatives exist, choose journeys that apply across providers or integrations before provider-specific examples; include at most one provider-specific journey. Extract up to twelve key domain concepts and only explicitly supported relations. Every concept and relation must cite exact scenario references. Return JSON only with this shape: {"journeys":[{"name":"","steps":[{"featureName":"","reference":"HP-1"}]}],"concepts":[{"name":"","summary":"","scenarioRefs":[{"featureName":"","reference":"HP-1"}],"relations":[{"targetName":"","summary":"","scenarioRef":{"featureName":"","reference":"HP-1"}}]}]}.\n\nProduct description: ${options.result.product.description}\n\nCandidate scenarios:\n${JSON.stringify(candidates)}`
    : `只使用这些已有、带证据的场景，为第一次接触项目的用户生成理解层。不得新增事实、对象、关系或结论。创建最多五条端到端用户旅程，每条包含 2-6 个有序的原有场景步骤，必须连接至少两个功能；证据不足就不要强行生成。优先选择产品级目标和跨模块流程，避免孤立的类调用。有其他选择时，优先生成可跨 Provider 或集成复用的旅程，Provider 专属实例最多保留一条。提取最多十二个关键领域概念，只建立有明确场景支持的关系。每个概念和关系都必须引用原有场景。只返回 JSON，结构为：{"journeys":[{"name":"","steps":[{"featureName":"","reference":"HP-1"}]}],"concepts":[{"name":"","summary":"","scenarioRefs":[{"featureName":"","reference":"HP-1"}],"relations":[{"targetName":"","summary":"","scenarioRef":{"featureName":"","reference":"HP-1"}}]}]}。\n\n产品简介：${options.result.product.description}\n\nCandidate scenarios:\n${JSON.stringify(candidates)}`;
  const details = parseJson(await options.client.complete([
    { role: "system", content: `You reorganize specifications without adding facts. Use ${languageName} for name and summary fields.` },
    { role: "user", content: detailPrompt },
  ]), detailSchema);
  return parseSnapshotPresentation(JSON.stringify({ ...grouping, ...details }), options.result);
}

export async function createSnapshotPresentation(options: {
  result: AnalysisResult;
  language: OutputLanguage;
  client: StructuredCompletionClient;
}): Promise<SnapshotPresentation> {
  if (options.result.features.length > 40) return createLargeSnapshotPresentation(options);
  const languageName = options.language === "en" ? "English" : "Simplified Chinese";
  const existing = options.result.features.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    scenarios: (feature.scenarios.some((scenario) => scenario.category === "happy") ? feature.scenarios.filter((scenario) => scenario.category === "happy") : feature.scenarios.slice(0, 1)).map((scenario) => ({ reference: scenario.reference, category: scenario.category, context: scenario.context, action: scenario.action, outcome: scenario.outcome })),
  }));
  const prompt = options.language === "en"
    ? `You are organizing an existing evidence-backed product specification for a first-time user. Do not add facts, features, scenarios, user roles, integrations, objects, relations, or claims. Start with a one-sentence tagline that names the user problem and the product's main parts in plain language, without leading with frameworks, library names, API names, deployment details, or implementation jargon. Group every existing feature into 4-8 product domains (fewer only when the input has fewer features). Use outcome-oriented domain names rather than implementation names. Technical and operational features must remain in the grouping rather than disappearing. Each domain has a short name, a one-sentence summary, exact existing featureNames, and up to two exact existing scenario references that best illustrate typical use. Every input feature must appear exactly once. Then create up to five end-to-end user journeys, each with 2-6 ordered existing scenario steps. A journey must connect at least two features when the product has multiple features; do not force a journey when the evidence does not support one. Prefer user goals and cross-module flows over isolated class calls or internal algorithms. Finally extract up to twelve key domain concepts and only explicitly supported relations between them. Every concept and relation must cite exact existing scenario references. Return JSON only with this shape: {"tagline":"","coreCapabilities":[{"name":"","summary":"","featureNames":[""],"scenarioRefs":[{"featureName":"","reference":"HP-1"}]}],"journeys":[{"name":"","steps":[{"featureName":"","reference":"HP-1"}]}],"concepts":[{"name":"","summary":"","scenarioRefs":[{"featureName":"","reference":"HP-1"}],"relations":[{"targetName":"","summary":"","scenarioRef":{"featureName":"","reference":"HP-1"}}]}]}.\n\nProduct description: ${options.result.product.description}\n\nExisting features:\n${JSON.stringify(existing)}`
    : `你在为第一次接触项目的用户整理一份已有、带证据的产品规格。不得新增事实、功能、场景、用户角色、集成、对象、关系或结论。先用一句话 tagline 说明产品解决什么问题、由哪些主要部分组成，避免以框架、库名、API 名、部署细节和实现术语开头。然后把所有现有功能归组为 4-8 个产品领域（输入功能更少时可更少），名称面向用户价值而非实现名称。技术与运维功能也要留在分组中，不能凭空删除。每个领域给出简短名称、一句话简介、原样 featureNames，以及最多两个最能说明典型用法的原有场景引用。每个输入功能必须恰好出现一次。然后创建最多五条端到端用户旅程，每条包含 2-6 个有序的原有场景步骤；产品有多个功能时，旅程必须连接至少两个功能，证据不足就不要强行生成。优先选择用户目标和跨模块流程，避免孤立的类调用或内部算法。最后提取最多十二个关键领域概念，只建立有明确场景支持的概念关系。每个概念和关系都必须引用原有场景。只返回 JSON，结构为：{"tagline":"","coreCapabilities":[{"name":"","summary":"","featureNames":[""],"scenarioRefs":[{"featureName":"","reference":"HP-1"}]}],"journeys":[{"name":"","steps":[{"featureName":"","reference":"HP-1"}]}],"concepts":[{"name":"","summary":"","scenarioRefs":[{"featureName":"","reference":"HP-1"}],"relations":[{"targetName":"","summary":"","scenarioRef":{"featureName":"","reference":"HP-1"}}]}]}。\n\n产品简介：${options.result.product.description}\n\n现有功能：\n${JSON.stringify(existing)}`;
  const content = await options.client.complete([
    { role: "system", content: `You reorganize specifications without adding facts. Use ${languageName} for name and summary fields.` },
    { role: "user", content: prompt },
  ]);
  return parseSnapshotPresentation(content, options.result);
}
