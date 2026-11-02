import { describe, expect, it } from "vitest";
import { buildFeatureFlow, clipFlowLabel, findEdgeNodes, sortScenarios } from "../lib/feature-flow";
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
  it("represents each scenario independently without terminal placeholders", () => {
    const flow = buildFeatureFlow(scenarios);
    const start = flow.nodes.find((node) => node.kind === "start");
    const hp1 = flow.nodes.find((node) => node.id === "HP-1");
    const hp2 = flow.nodes.find((node) => node.id === "HP-2");
    const error = flow.nodes.find((node) => node.id === "ER-1");
    const end = flow.nodes.find((node) => node.id === "end-0");
    expect(start).toBeDefined();
    expect(hp1).toBeDefined();
    expect(hp2).toBeDefined();
    expect(error).toBeDefined();
    expect(end).toBeUndefined();
    expect(start).toMatchObject({ title: "开始：Visitor" });
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: start!.id, to: "HP-1" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: start!.id, to: "HP-2" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: start!.id, to: "ER-1" }));
    expect(flow.edges).not.toContainEqual(expect.objectContaining({ from: "HP-1", to: "HP-2" }));
    expect(hp1!.x).toBeLessThan(hp2!.x);
    expect(hp1).toMatchObject({ x: 200, y: 60 });
    expect(hp2).toMatchObject({ x: 390, y: 60 });
    expect(error).toMatchObject({ x: 200, y: 150 });
    expect(flow).toMatchObject({ width: 640, height: 230 });
  });

  it("handles multiple contexts and empty features", () => {
    const flow = buildFeatureFlow([
      { reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", evidence: [] },
      { reference: "HP-2", context: "Signed in", action: "Signs out", outcome: "Login", category: "happy", evidence: [] },
    ]);
    expect(flow.nodes.filter((node) => node.kind === "start")).toHaveLength(2);
    expect(flow.edges).toHaveLength(2);
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start-0", to: "HP-1" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start-1", to: "HP-2" }));
    expect(flow.edges).not.toContainEqual(expect.objectContaining({ from: "end-0", to: "start-1" }));
    expect(flow.nodes.find((node) => node.id === "start-1")).toMatchObject({ title: "开始：Signed in", x: 20, y: 250 });
    expect(flow.nodes.find((node) => node.id === "end-1")).toBeUndefined();
    expect(flow).toMatchObject({ width: 640, height: 420 });

    const empty = buildFeatureFlow([]);
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty).toMatchObject({ width: 640, height: 230 });
    const single = buildFeatureFlow([scenarios[0]]);
    expect(findEdgeNodes(single.edges[0], single.nodes)).toEqual({ source: single.nodes[0], target: single.nodes[1] });
    expect(findEdgeNodes({ id: "missing", from: "none", to: "HP-2" }, single.nodes)).toBeUndefined();
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
    expect(flow.width).toBe(1330);
  });

  it("connects excess branches to the context start", () => {
    const flow = buildFeatureFlow([
      { reference: "HP-1", context: "Visitor", action: "Acts", outcome: "Done", category: "happy", evidence: [] },
      { reference: "EC-1", context: "Visitor", action: "Edges", outcome: "Edge", category: "edge", evidence: [] },
      { reference: "ER-1", context: "Visitor", action: "Fails", outcome: "Error", category: "error", evidence: [] },
    ]);
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start-0", to: "EC-1" }));
    expect(flow.edges).toContainEqual(expect.objectContaining({ from: "start-0", to: "ER-1" }));
    expect(flow.edges).not.toContainEqual(expect.objectContaining({ from: "HP-1", to: "EC-1" }));
    expect(flow.nodes.find((node) => node.id === "ER-1")).toMatchObject({ x: 390, y: 150 });
  });
});
