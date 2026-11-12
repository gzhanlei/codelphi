import { describe, expect, it } from "vitest";
import type { FeatureFlowGraph } from "../lib/semantic-feature-flow";
import type { ScenarioRow } from "../lib/types";

const graph: FeatureFlowGraph = {
  entryNodeIds: ["start"],
  nodes: [
    { id: "start", kind: "start", title: "开始工作", scenarioRefs: [] },
    { id: "a", kind: "action", title: "填写邮箱、SAU 数量与原因后点击「发放」", scenarioRefs: ["HP-1"] },
    { id: "b", kind: "action", title: "展示钱包余额", scenarioRefs: ["HP-2"] },
  ],
  edges: [
    { id: "e1", from: "start", to: "a", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e2", from: "a", to: "b", kind: "sequence", scenarioRefs: ["HP-2"] },
  ],
  excludedScenarios: [{ reference: "HP-3", reason: "documentary" }],
};

const scenarios: ScenarioRow[] = [
  { id: 1, featureId: 1, reference: "HP-1", context: "超管需要补发额度", action: "填写邮箱、SAU 数量与原因后点击「发放」", outcome: "发放成功并显示钱包余额，或同 reason 幂等跳过", category: "happy", source: "generated", evidence: JSON.stringify([{ path: "components/admin-billing-grant.tsx", startLine: 15, url: "https://example.com/evidence" }]), staleSince: null, staleChangeId: null },
  { id: 2, featureId: 1, reference: "HP-2", context: "发放成功", action: "展示钱包余额", outcome: "余额可见", category: "happy", source: "generated", evidence: [], staleSince: null, staleChangeId: null },
  { id: 3, featureId: 1, reference: "HP-3", context: "需要理解决策", action: "阅读历史决策", outcome: "知道原因", category: "happy", source: "generated", evidence: [], staleSince: null, staleChangeId: null },
];

describe("FeatureFlow component", () => {
  it("shows an honest fallback instead of manufacturing a START fan-out", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureFlow } = await import("../components/feature-flow");
    const html = renderToStaticMarkup(createElement(FeatureFlow, { featureName: "测试功能", scenarios }));
    expect(html).toContain("流程图尚未生成");
    expect(html).not.toContain("开始工作");
    expect(html).not.toContain("<svg");
  });

  it("explains the guardrail rejection reason in plain language when present", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureFlow } = await import("../components/feature-flow");
    const html = renderToStaticMarkup(createElement(FeatureFlow, { featureName: "测试功能", scenarios, errorCode: "MAIN_CHAIN_MISSING" }));
    expect(html).toContain("没有形成可表达的先后主链");
    expect(html).not.toContain("MAIN_CHAIN_MISSING");
    expect(html).not.toContain("<svg");
  });

  it("renders excluded documentary scenarios outside the main flow", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureFlow } = await import("../components/feature-flow");
    const html = renderToStaticMarkup(createElement(FeatureFlow, { featureName: "测试功能", scenarios, graph }));
    expect(html).toContain("不纳入主流程");
    expect(html).toContain("阅读历史决策");
    expect(html).toContain("documentary");
  });

  it("renders complete scenario text and code evidence in the details panel", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureFlowDetails } = await import("../components/feature-flow");
    const html = renderToStaticMarkup(createElement(FeatureFlowDetails, { title: "发放额度", scenarios: [scenarios[0]], onClose: () => undefined }));
    expect(html).toContain(scenarios[0].outcome);
    expect(html).toContain("components/admin-billing-grant.tsx:15");
    expect(html).toContain("https://example.com/evidence");
    expect(html).toContain("关闭详情");
  });

  it("keeps the complete long title and avoids the scenario list class", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureNode } = await import("../components/feature-flow");
    const { ReactFlowProvider } = await import("@xyflow/react");
    const node = graph.nodes[1];
    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(FeatureNode, {
      data: { title: node.title, kind: node.kind, scenarios: [scenarios[0]] },
    } as never)));
    expect(html).toContain(node.title);
    expect(html).toContain("scenario-node");
    expect(html).not.toContain("flow-react-node scenario ");
  });
});
