import { requestStructuredCompletion, type LlmBillingContext } from "./ai";
import { FEATURE_FLOW_MAX_ENTRIES, FlowValidationError, validateFeatureFlowGraph, type FeatureFlowGraph } from "./semantic-feature-flow";
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
    "主路径应清楚表达真实执行顺序；判断、错误、外部等待和终态挂在对应步骤上。说明性、历史决策、重复或无法支持图关系的场景放入 excludedScenarios，不要混入主图。excludedScenarios 中的 reference 不得出现在任何节点或边的 scenarioRefs 中。",
    "一个节点可以聚合多条场景。除合成 START 外，每个节点都必须引用当前功能的场景；每条边都必须引用当前功能的场景。END 必须有终态证据，retry 必须有重试或返回上一步的证据。",
    `最多 24 个节点、48 条边、${FEATURE_FLOW_MAX_ENTRIES} 个真正独立入口。入口=独立子流程的起点（如认证的密码登录/扫码/SSO、MFA 的启用/验证/恢复），不是逐场景设口；入口数超过上限时优先把同子流程合并到一条入口链。禁止未归属场景默认连接 START，禁止为了让图连通而补造关系。没有至少两个操作节点的主链时返回空节点和边，并把场景标记为 unsupported。`,
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

function normalizeEmptyLabels(graph: unknown): unknown {
  if (typeof graph !== "object" || graph === null || !("edges" in graph)) return graph;
  const edges = (graph as { edges?: unknown }).edges;
  if (!Array.isArray(edges)) return graph;
  return {
    ...graph,
    edges: edges.map((edge) => {
      if (typeof edge !== "object" || edge === null) return edge;
      const record = edge as Record<string, unknown>;
      return typeof record.label === "string" && record.label.trim() === "" ? { ...record, label: undefined } : record;
    }),
  };
}

export async function generateFeatureFlowGraph(feature: SpecFeature, billing?: LlmBillingContext): Promise<FeatureFlowGraph> {
  const messages = [
    { role: "system", content: "你是严谨的产品流程分析器，只输出可验证的结构化 JSON。" },
    { role: "user", content: featureFlowPrompt(feature) },
  ];
  const receipt = billing ? { ...billing, callKind: "feature_flow" } : undefined;
  const content = await requestStructuredCompletion(messages, receipt);
  try {
    return validateFeatureFlowGraph(normalizeEmptyLabels(parseContent(content)), feature.scenarios);
  } catch (error) {
    if (!(error instanceof FlowValidationError)) throw error;
    const correction = await requestStructuredCompletion([
      ...messages,
      { role: "assistant", content },
      { role: "user", content: `上次输出未通过校验：${error.message}。请完整重新生成并修正，不得只返回局部修改。excludedScenarios 中的 reference 不得出现在任何节点或边的 scenarioRefs 中；其他证据与主链要求保持不变。` },
    ], receipt);
    return validateFeatureFlowGraph(normalizeEmptyLabels(parseContent(correction)), feature.scenarios);
  }
}
