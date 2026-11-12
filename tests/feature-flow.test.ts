import { describe, expect, it } from "vitest";
import { buildFeatureFlow, clipFlowLabel, findEdgeNodes, hasFlowStructure, sortScenarios } from "../lib/feature-flow";
import type { SpecScenario } from "../lib/spec-diff";

const scenarios = [
  { reference: "HP-2", context: "Visitor", action: "Uses OAuth", outcome: "Dashboard", category: "happy" as const, evidence: [] },
  { reference: "HP-1", context: "Visitor", action: "Uses password", outcome: "Dashboard", category: "happy" as const, evidence: [] },
  { reference: "ER-1", context: "Visitor", action: "Uses wrong password", outcome: "Generic error", category: "error" as const, evidence: [] },
];

describe("feature flow generation", () => {
  it("clips labels by display width for Chinese and ASCII text", () => {
    expect(clipFlowLabel("Short")).toBe("Short");
    expect(clipFlowLabel("12345", 5)).toBe("12345");
    expect(clipFlowLabel("ÿ", 1)).toBe("ÿ");
    expect(clipFlowLabel("123456789012345678901234")).toBe("1234567890123456789…");
    expect(clipFlowLabel("一二三四五六七八九十甲")).toBe("一二三四五六七八九…");
  });
  it("reports a single stepless context as unstructured while still laying out nodes", () => {
    const flow = buildFeatureFlow(scenarios);
    const start = flow.nodes.find((node) => node.kind === "start");
    const hp1 = flow.nodes.find((node) => node.id === "HP-1");
    const hp2 = flow.nodes.find((node) => node.id === "HP-2");
    const error = flow.nodes.find((node) => node.id === "ER-1");
    const end = flow.nodes.find((node) => node.id === "end-0");
    expect(flow.structured).toBe(false);
    expect(start).toMatchObject({ id: "start", title: "开始工作", x: 20, y: 60 });
    expect(hp1).toMatchObject({ x: 200, y: 60 });
    expect(hp2).toMatchObject({ x: 200, y: 140 });
    expect(error).toMatchObject({ kind: "branch", x: 200, y: 220 });
    expect(end).toBeUndefined();
    expect(flow.edges.map((edge) => [edge.from, edge.to])).toEqual([["start", "HP-1"], ["start", "HP-2"], ["start", "ER-1"]]);
    expect(flow.edges[0].label).toBe("Visitor");
    expect(flow.edges[1].label).toBeUndefined();
    expect(flow.edges[2].label).toBeUndefined();
    expect(flow).toMatchObject({ width: 640, height: 350 });
  });

  it("folds multiple contexts into one entry with condition-labeled edges", () => {
    const flow = buildFeatureFlow([
      { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", evidence: [] },
      { reference: "HP-2", context: "Signed in", action: "Signs out", outcome: "Login", category: "happy", evidence: [] },
    ]);
    expect(flow.structured).toBe(true);
    expect(flow.nodes.filter((node) => node.kind === "start")).toHaveLength(1);
    expect(flow.edges).toHaveLength(2);
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-1", label: "Visitor" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-2", label: "Signed in" }));
    expect(flow.edges).not.toContainEqual(expect.objectContaining({ from: "end-0", to: "start-1" }));
    expect(flow.nodes.find((node) => node.id === "start")).toMatchObject({ title: "开始工作", x: 20, y: 60 });
    expect(flow.nodes.find((node) => node.id === "HP-1")).toMatchObject({ x: 200, y: 60 });
    expect(flow.nodes.find((node) => node.id === "HP-2")).toMatchObject({ x: 200, y: 160 });
    expect(flow).toMatchObject({ width: 640, height: 290 });

    const empty = buildFeatureFlow([]);
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.structured).toBe(false);
    expect(empty).toMatchObject({ width: 640, height: 230 });
    const single = buildFeatureFlow([scenarios[0]]);
    expect(single.structured).toBe(false);
    expect(findEdgeNodes(single.edges[0], single.nodes)).toEqual({ source: single.nodes[0], target: single.nodes[1] });
    expect(findEdgeNodes({ id: "missing", from: "none", to: "HP-2" }, single.nodes)).toBeUndefined();
  });

  it("labels only the first edge of each context group", () => {
    const flow = buildFeatureFlow([
      { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", evidence: [] },
      { reference: "HP-3", context: "Visitor", action: "Resets password", outcome: "Email sent", category: "happy", evidence: [] },
      { reference: "HP-2", context: "Signed in", action: "Signs out", outcome: "Login", category: "happy", evidence: [] },
    ]);
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-1", label: "Visitor" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-3" }));
    expect(flow.edges.find((edge) => edge.to === "HP-3")!.label).toBeUndefined();
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-2", label: "Signed in" }));
  });

  it("sorts categories, numeric references and lexical tie breakers", () => {
    const unordered: SpecScenario[] = [
      { reference: "ER-2", context: "Visitor", action: "Fails", outcome: "Error", category: "error", evidence: [] },
      { reference: "EC-10", context: "Visitor", action: "Edges", outcome: "Edge", category: "edge", evidence: [] },
      { reference: "HP-10", context: "Visitor", action: "Ten", outcome: "Done", category: "happy", evidence: [] },
      { reference: "HP-2", context: "Visitor", action: "Two", outcome: "Done", category: "happy", evidence: [] },
      { reference: "AA-2", context: "Visitor", action: "Tie", outcome: "Done", category: "happy", evidence: [] },
      { reference: "HP-X", context: "Visitor", action: "Unnumbered", outcome: "Done", category: "happy", evidence: [] },
      { reference: "ZZ-X", context: "Visitor", action: "Unnumbered tie", outcome: "Done", category: "happy", evidence: [] },
      { reference: "AA-1", context: "Visitor", action: "Numbered one", outcome: "Done", category: "happy", evidence: [] },
    ];
    const flow = buildFeatureFlow(unordered);
    const ordered = ["HP-X", "ZZ-X", "AA-1", "AA-2", "HP-2", "HP-10", "EC-10", "ER-2"];
    expect(sortScenarios(unordered).map((scenario) => scenario.reference)).toEqual(ordered);
    expect(flow.nodes.filter((node) => node.kind === "scenario").map((node) => node.id)).toEqual(ordered.slice(0, 6));
    expect(flow.nodes.filter((node) => node.reference).map((node) => node.id)).toEqual(ordered);
    expect(flow.nodes.filter((node) => node.kind === "branch").map((node) => node.id)).toEqual(["EC-10", "ER-2"]);
    expect(flow.width).toBe(640);
  });

  it("connects stepless branches to the shared entry", () => {
    const flow = buildFeatureFlow([
      { reference: "HP-1", context: "Visitor", action: "Acts", outcome: "Done", category: "happy", evidence: [] },
      { reference: "EC-1", context: "Visitor", action: "Edges", outcome: "Edge", category: "edge", evidence: [] },
      { reference: "ER-1", context: "Visitor", action: "Fails", outcome: "Error", category: "error", evidence: [] },
    ]);
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "EC-1" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "ER-1" }));
    expect(flow.edges).not.toContainEqual(expect.objectContaining({ from: "HP-1", to: "EC-1" }));
    expect(flow.nodes.find((node) => node.id === "ER-1")).toMatchObject({ x: 200, y: 220 });
  });
});

describe("FeatureFlow component", () => {
  it("renders complete scenario text and code evidence in the details panel", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureFlowDetails: Details } = await import("../components/feature-flow");
    expect(Details).toBeTypeOf("function");

    const longOutcome = "这是一个特别长的结果描述，用来验证详情面板完整展示结果和代码证据";
    const scenario = {
      id: 1, featureId: 1, reference: "HP-1", context: "情境", action: "操作", outcome: longOutcome,
      category: "happy" as const, source: "generated" as const, active: 1,
      evidence: JSON.stringify([{ path: "lib/example.ts", startLine: 12, url: "https://example.com/evidence" }]),
      staleSince: null, staleChangeId: null,
    };
    const html = renderToStaticMarkup(createElement(Details, { title: "连接代码库", scenarios: [scenario], onClose: () => undefined }));
    expect(html).toContain(longOutcome);
    expect(html).toContain("lib/example.ts:12");
    expect(html).toContain("https://example.com/evidence");
    expect(html).toContain("关闭详情");
  });
  it("uses a flow-specific node class instead of the scenario list class", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureNode: NodeComponent } = await import("../components/feature-flow");
    const { ReactFlowProvider } = await import("@xyflow/react");

    const html = renderToStaticMarkup(createElement(ReactFlowProvider, null, createElement(NodeComponent, {
      data: { title: "填写邮箱、SAU 数量与原因后点击「发放」", outcome: "发放成功", kind: "scenario", category: "happy", scenarios: [] },
    } as never)));
    expect(html).toContain("flow-react-node scenario-node");
    expect(html).not.toContain("flow-react-node scenario ");
  });
  it("renders the structure fallback instead of an SVG when no control structure exists", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { FeatureFlow } = await import("../components/feature-flow");
    const scenario = {
      id: 1, featureId: 1, reference: "HP-1", context: "单一情境", action: "操作", outcome: "结果",
      category: "happy", source: "generated", active: 1, evidence: "[]", staleSince: null, staleChangeId: null,
    } as never;
    const html = renderToStaticMarkup(createElement(FeatureFlow, { featureName: "测试功能", scenarios: [scenario] }));
    expect(html).not.toContain("<svg");
    expect(html).toContain("暂不渲染流程图");
  });
});

describe("scenario step chain (W-DECISION 最小序列版)", () => {
  const stepped = [
    { reference: "HP-1", context: "Visitor", action: "Connect a repository", outcome: "Repository linked", category: "happy" as const, step: 1, evidence: [] },
    { reference: "HP-2", context: "Visitor", action: "Trigger first analysis", outcome: "Spec generated", category: "happy" as const, step: 2, evidence: [] },
    { reference: "EC-1", context: "Visitor", action: "Repository over size limit", outcome: "Warning with limit request", category: "edge" as const, step: 1, evidence: [] },
    { reference: "ER-1", context: "Visitor", action: "Token rejected", outcome: "Reconnect banner", category: "error" as const, evidence: [] },
  ];

  it("chains stepped happy scenarios in step order and attaches branches to their step", () => {
    const flow = buildFeatureFlow(stepped);
    expect(flow.structured).toBe(true);
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-1", label: "Visitor" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "HP-1", to: "HP-2" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "HP-1", to: "EC-1" }));
    // 无 step 的错误场景保持入口扇出，不虚构顺序
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "ER-1" }));
    const hp1 = flow.nodes.find((node) => node.id === "HP-1")!;
    const hp2 = flow.nodes.find((node) => node.id === "HP-2")!;
    const ec1 = flow.nodes.find((node) => node.id === "EC-1")!;
    const er1 = flow.nodes.find((node) => node.id === "ER-1")!;
    expect(hp1.x).toBeLessThan(hp2.x);
    expect(ec1).toMatchObject({ x: 200, y: 150 });
    expect(er1).toMatchObject({ x: 200, y: 230 });
    expect(er1.y).toBeGreaterThan(ec1.y);
    expect(flow.height).toBe(360);
  });

  it("renders stepless single-context fan-out from the shared entry", () => {
    const legacy = buildFeatureFlow([
      { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", evidence: [] },
      { reference: "HP-2", context: "Visitor", action: "Signs out", outcome: "Login", category: "happy", evidence: [] },
    ]);
    expect(legacy.edges.map((edge) => [edge.from, edge.to])).toEqual([["start", "HP-1"], ["start", "HP-2"]]);
    expect(legacy.nodes.find((node) => node.id === "HP-2")).toMatchObject({ x: 200, y: 140 });
    expect(legacy.structured).toBe(false);
  });

  it("ignores out-of-range steps deterministically", () => {
    const flow = buildFeatureFlow([
      { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", step: 99, evidence: [] },
    ]);
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start", to: "HP-1" }));
    expect(flow.edges.filter((edge) => edge.from === "HP-1")).toHaveLength(0);
  });
});

describe("hasFlowStructure", () => {
  it("requires either multiple context groups or a stepped happy chain", () => {
    expect(hasFlowStructure([])).toBe(false);
    expect(hasFlowStructure([{ reference: "HP-1", context: "A", action: "Act", outcome: "Done", category: "happy", evidence: [] }])).toBe(false);
    expect(hasFlowStructure([
      { reference: "HP-1", context: "A", action: "Act", outcome: "Done", category: "happy", evidence: [] },
      { reference: "HP-2", context: "B", action: "Act", outcome: "Done", category: "happy", evidence: [] },
    ])).toBe(true);
    expect(hasFlowStructure([
      { reference: "HP-1", context: "A", action: "Act", outcome: "Done", category: "happy", step: 1, evidence: [] },
    ])).toBe(true);
  });
});
