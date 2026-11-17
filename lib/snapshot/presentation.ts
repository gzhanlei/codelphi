import { z } from "zod";
import type { OutputLanguage } from "../analysis-language";
import type { AnalysisResult } from "../ai";
import type { StructuredCompletionClient } from "../llm-client";
import type { SnapshotCoreCapability, SnapshotPresentation } from "./types";

const presentationSchema = z.object({
  tagline: z.string().trim().min(1).max(300),
  coreCapabilities: z.array(z.object({
    name: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(600),
    featureNames: z.array(z.string().trim().min(1)).min(1),
    scenarioRefs: z.array(z.object({ featureName: z.string().trim().min(1), reference: z.string().trim().min(1) })).max(2),
  })).min(1).max(6),
});

function firstScenario(feature: AnalysisResult["features"][number]) {
  return feature.scenarios.find((scenario) => scenario.category === "happy") ?? feature.scenarios[0];
}

function withIds(capabilities: Array<Omit<SnapshotCoreCapability, "id">>, tagline?: string): SnapshotPresentation {
  return { coreCapabilities: capabilities.map((capability, index) => ({ ...capability, id: `capability-${index + 1}` })), ...(tagline ? { tagline } : {}) };
}

export function fallbackSnapshotPresentation(result: Pick<AnalysisResult, "features">, language: OutputLanguage): SnapshotPresentation {
  const singleFeatures = result.features.slice(0, 5);
  const capabilities: Array<Omit<SnapshotCoreCapability, "id">> = singleFeatures.map((feature) => {
    const scenario = firstScenario(feature);
    return {
      name: feature.name,
      summary: feature.summary,
      featureNames: [feature.name],
      scenarioRefs: scenario ? [{ featureName: feature.name, reference: scenario.reference }] : [],
    };
  });
  if (result.features.length > 5) {
    const remaining = result.features.slice(5);
    capabilities.push({
      name: language === "en" ? "Supporting capabilities" : "其他能力",
      summary: language === "en" ? "Additional implementation and supporting specifications." : "其余实现与支撑规格。",
      featureNames: remaining.map((feature) => feature.name),
      scenarioRefs: remaining.slice(0, 2).flatMap((feature) => {
        const scenario = firstScenario(feature);
        return scenario ? [{ featureName: feature.name, reference: scenario.reference }] : [];
      }),
    });
  }
  return withIds(capabilities);
}

function parseJson(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return presentationSchema.parse(JSON.parse(trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)));
}

function validatePresentation(presentation: z.infer<typeof presentationSchema>, result: AnalysisResult) {
  const featureByName = new Map(result.features.map((feature) => [feature.name, feature]));
  const assigned = new Set<string>();
  for (const capability of presentation.coreCapabilities) {
    for (const featureName of capability.featureNames) {
      if (!featureByName.has(featureName) || assigned.has(featureName)) throw new Error("Invalid feature coverage in presentation");
      assigned.add(featureName);
    }
    for (const ref of capability.scenarioRefs) {
      if (!capability.featureNames.includes(ref.featureName)) throw new Error("Scenario reference escapes its capability");
      const feature = featureByName.get(ref.featureName);
      if (!feature?.scenarios.some((scenario) => scenario.reference === ref.reference)) throw new Error("Unknown scenario reference in presentation");
    }
  }
  if (assigned.size !== result.features.length) throw new Error("Presentation must cover every existing feature without adding new ones");
  return withIds(presentation.coreCapabilities, presentation.tagline);
}

export async function createSnapshotPresentation(options: {
  result: AnalysisResult;
  language: OutputLanguage;
  client: StructuredCompletionClient;
}): Promise<SnapshotPresentation> {
  const languageName = options.language === "en" ? "English" : "Simplified Chinese";
  const existing = options.result.features.map((feature) => ({
    name: feature.name,
    summary: feature.summary,
    scenarios: feature.scenarios.map((scenario) => ({ reference: scenario.reference, category: scenario.category, context: scenario.context, action: scenario.action, outcome: scenario.outcome })),
  }));
  const prompt = options.language === "en"
    ? `You are organizing an existing evidence-backed product specification for a first-time user. Do not add facts, features, scenarios, user roles, integrations, or claims. Start with a one-sentence tagline that explains what the product lets people do in plain language, without library names, API names, deployment details, or implementation jargon. Then group the existing features into 4-6 core capabilities (fewer only when the input has fewer features). Use plain, outcome-oriented language rather than implementation names. Technical and operational features must remain in the grouping rather than disappearing. For each capability, provide a short name, a one-sentence summary, exact existing featureNames, and up to two exact existing scenario references that best help a new user understand typical use. Scenario references must emphasize what a user does and sees, not JSON shapes, function names, database fields, deployment steps, or internal algorithms whenever that capability has a user-facing alternative. Every input feature must appear exactly once. Return JSON only with this shape: {"tagline":"","coreCapabilities":[{"name":"","summary":"","featureNames":[""],"scenarioRefs":[{"featureName":"","reference":"HP-1"}]}]}.\n\nProduct description: ${options.result.product.description}\n\nExisting features:\n${JSON.stringify(existing)}`
    : `你在为第一次接触项目的用户整理一份已有、带证据的产品规格。不得新增事实、功能、场景、用户角色、集成或结论。先用一句话 tagline 说明用户能用这个产品做什么，避免库名、API 名、部署细节和实现术语。然后把现有功能归组为 4-6 个核心能力（输入功能更少时可更少）。名称和简介必须面向用户价值，避免实现术语。技术与运维功能也要留在分组中，不能凭空删除。每个能力给出简短名称、一句话简介、原样 featureNames，以及最多两个最能帮助新用户理解典型用法的原有场景引用。场景引用必须强调用户做什么、看到什么；如果该能力存在面向用户的其他场景，就不要选择 JSON 结构、函数名、数据库字段、部署步骤或内部算法为主的场景。每个输入功能必须恰好出现一次。只返回 JSON，结构为：{"tagline":"","coreCapabilities":[{"name":"","summary":"","featureNames":[""],"scenarioRefs":[{"featureName":"","reference":"HP-1"}]}]}。\n\n产品简介：${options.result.product.description}\n\n现有功能：\n${JSON.stringify(existing)}`;
  const content = await options.client.complete([
    { role: "system", content: `You reorganize specifications without adding facts. Use ${languageName} for name and summary fields.` },
    { role: "user", content: prompt },
  ]);
  return validatePresentation(parseJson(content), options.result);
}
