import { requestStructuredCompletion, type LlmBillingContext, type ModelCallOptions } from "./ai";
import { withNoSourceOutput } from "./prompt-policy";
import { FEATURE_FLOW_MAX_ENTRIES, FlowValidationError, validateFeatureFlowGraph, type FeatureFlowGraph } from "./semantic-feature-flow";
import type { SpecFeature } from "./spec-diff";
import type { OutputLanguage } from "./analysis-language";

export function featureFlowPrompt(feature: SpecFeature, language: OutputLanguage = "zh-CN") {
  const scenarios = feature.scenarios.map((scenario) => ({
    reference: scenario.reference,
    category: scenario.category,
    context: scenario.context,
    action: scenario.action,
    outcome: scenario.outcome,
    step: scenario.step ?? null,
    evidence: scenario.evidence.map((item) => item.path),
  }));
  if (language === "en") {
    return [
      "Organize the product scenarios into a verifiable user execution graph. Use only relationships expressible from the input scenarios; never speculate.",
      "The main path must express the real execution order; decisions, errors, external waits and terminal states attach to their corresponding steps. Put explanatory, historical-decision, duplicate or graph-unsupportable scenarios into excludedScenarios; never mix them into the main graph. A reference in excludedScenarios must not appear in any node or edge scenarioRefs.",
      "One node may aggregate several scenarios. Except for the synthetic START, every node must reference scenarios of the current feature; every edge must reference scenarios of the current feature. END requires terminal-state evidence; retry requires retry or step-back evidence.",
      `At most 24 nodes, 48 edges and ${FEATURE_FLOW_MAX_ENTRIES} genuinely independent entries. An entry = the start of an independent sub-flow (e.g. password sign-in / QR / SSO for auth, enable/verify/recover for MFA), not one per scenario; when entries exceed the cap, merge same-sub-flow chains into one entry first. Scenarios must not be silently attached to START by default, and never fabricate relationships just to connect the graph. Without a main chain of at least two action nodes, return empty nodes and edges and mark the scenarios unsupported.`,
      'Return JSON only: {"entryNodeIds":["start"],"nodes":[{"id":"start","kind":"start|action|decision|error|external|waiting|end","title":"","scenarioRefs":["HP-1"]}],"edges":[{"id":"e1","from":"start","to":"step","kind":"sequence|branch|retry","label":"","scenarioRefs":["HP-1"]}],"excludedScenarios":[{"reference":"HP-2","reason":"documentary|duplicate|unsupported|out-of-scope"}]}',
      `Feature: ${feature.name}`,
      `Summary: ${feature.summary}`,
      `Scenarios: ${JSON.stringify(scenarios)}`,
    ].join("\n");
  }
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

/** 流程图生成不读源码，所以客户端分析也能做：注入自己的模型客户端即可（修订稿 §5.4）。 */
export async function generateFeatureFlowGraph(feature: SpecFeature, billing?: LlmBillingContext, language: OutputLanguage = "zh-CN", options: ModelCallOptions = {}): Promise<FeatureFlowGraph> {
  const messages = [
    { role: "system", content: language === "en" ? "You are a rigorous product flow analyzer that outputs only verifiable structured JSON." : "你是严谨的产品流程分析器，只输出可验证的结构化 JSON。" },
    { role: "user", content: withNoSourceOutput(featureFlowPrompt(feature, language), language, options.noSourceOutput) },
  ];
  const receipt = billing ? { ...billing, callKind: "feature_flow" } : undefined;
  const complete = (calls: Array<{ role: string; content: string }>): Promise<string> => (options.client ? options.client.complete(calls) : requestStructuredCompletion(calls, receipt));
  const content = await complete(messages);
  try {
    return validateFeatureFlowGraph(normalizeEmptyLabels(parseContent(content)), feature.scenarios);
  } catch (error) {
    if (!(error instanceof FlowValidationError)) throw error;
    const correction = await complete([
      ...messages,
      { role: "assistant", content },
      { role: "user", content: language === "en"
        ? `The previous output failed validation: ${error.message}. Regenerate it completely with the fix — do not return a partial patch. A reference in excludedScenarios must not appear in any node or edge scenarioRefs; the evidence and main-chain requirements are unchanged.`
        : `上次输出未通过校验：${error.message}。请完整重新生成并修正，不得只返回局部修改。excludedScenarios 中的 reference 不得出现在任何节点或边的 scenarioRefs 中；其他证据与主链要求保持不变。` },
    ]);
    return validateFeatureFlowGraph(normalizeEmptyLabels(parseContent(correction)), feature.scenarios);
  }
}
