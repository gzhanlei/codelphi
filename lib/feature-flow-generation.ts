import { requestStructuredCompletion, type LlmBillingContext } from "./ai";
import { validateFeatureFlowGraph, type FeatureFlowGraph } from "./semantic-feature-flow";
import type { SpecFeature } from "./spec-diff";

export function featureFlowPrompt(feature: SpecFeature) {
  const scenarios = feature.scenarios.map((scenario) => ({
    reference: scenario.reference,
    category: scenario.category,
    context: scenario.context,
    action: scenario.action,
    outcome: scenario.outcome,
    step: scenario.step ?? null,
    evidence: scenario.evidence.map((item) => item.path),
  }));
  return [
    "把产品场景整理成可验证的用户执行图。只能使用输入场景表达的关系，不得补充猜测。",
    "主路径应清楚表达真实执行顺序；判断、错误、外部等待和终态挂在对应步骤上。说明性、历史决策、重复或无法支持图关系的场景放入 excludedScenarios，不要混入主图。",
    "一个节点可以聚合多条场景。除合成 START 外，每个节点都必须引用当前功能的场景；每条边都必须引用当前功能的场景。END 必须有终态证据，retry 必须有重试或返回上一步的证据。",
    "最多 24 个节点、48 条边、3 个真正独立入口。禁止未归属场景默认连接 START，禁止为了让图连通而补造关系。没有至少两个操作节点的主链时返回空节点和边，并把场景标记为 unsupported。",
    "只返回 JSON：{\"entryNodeIds\":[\"start\"],\"nodes\":[{\"id\":\"start\",\"kind\":\"start|action|decision|error|external|waiting|end\",\"title\":\"\",\"scenarioRefs\":[\"HP-1\"]}],\"edges\":[{\"id\":\"e1\",\"from\":\"start\",\"to\":\"step\",\"kind\":\"sequence|branch|retry\",\"label\":\"\",\"scenarioRefs\":[\"HP-1\"]}],\"excludedScenarios\":[{\"reference\":\"HP-2\",\"reason\":\"documentary|duplicate|unsupported|out-of-scope\"}]}",
    `功能：${feature.name}`,
    `摘要：${feature.summary}`,
    `场景：${JSON.stringify(scenarios)}`,
  ].join("\n");
}

function parseContent(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  return JSON.parse(unfenced) as unknown;
}

export async function generateFeatureFlowGraph(feature: SpecFeature, billing?: LlmBillingContext): Promise<FeatureFlowGraph> {
  const content = await requestStructuredCompletion([
    { role: "system", content: "你是严谨的产品流程分析器，只输出可验证的结构化 JSON。" },
    { role: "user", content: featureFlowPrompt(feature) },
  ], billing ? { ...billing, callKind: "feature_flow" } : undefined);
  return validateFeatureFlowGraph(parseContent(content), feature.scenarios);
}
