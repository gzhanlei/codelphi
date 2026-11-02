import type { SpecScenario } from "./spec-diff";

export interface FlowNode {
  id: string;
  kind: "start" | "scenario" | "branch";
  reference?: string;
  title: string;
  outcome?: string;
  category?: SpecScenario["category"];
  x: number;
  y: number;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
}

function characterWidth(character: string) {
  return character.codePointAt(0)! > 255 ? 2 : 1;
}

function displayWidth(value: string) {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

export function clipFlowLabel(value: string, limit = 20) {
  if (displayWidth(value) <= limit) return value;
  let result = "";
  for (const character of value) {
    if (displayWidth(result + character) + 1 > limit) break;
    result += character;
  }
  return `${result}…`;
}

export function findEdgeNodes(edge: FlowEdge, nodes: FlowNode[]) {
  const source = nodes.find((node) => node.id === edge.from);
  const target = nodes.find((node) => node.id === edge.to);
  return source && target ? { source, target } : undefined;
}

export interface FeatureFlow {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

function scenarioRank(scenario: SpecScenario) {
  return { happy: 0, edge: 1, error: 2 }[scenario.category];
}

function referenceNumber(reference: string) {
  const match = reference.match(/\d+$/);
  return match ? Number(match[0]) : 0;
}

export function sortScenarios(scenarios: SpecScenario[]) {
  return [...scenarios].sort((a, b) => scenarioRank(a) - scenarioRank(b) || referenceNumber(a.reference) - referenceNumber(b.reference) || a.reference.localeCompare(b.reference));
}

function contextGroups(scenarios: SpecScenario[]) {
  const groups = new Map<string, SpecScenario[]>();
  for (const scenario of sortScenarios(scenarios)) {
    const items = groups.get(scenario.context);
    if (items) {
      items.push(scenario);
    } else {
      groups.set(scenario.context, [scenario]);
    }
  }
  return [...groups.values()];
}

export function buildFeatureFlow(scenarios: SpecScenario[]): FeatureFlow {
  const groups = contextGroups(scenarios);
  if (groups.length === 0) {
    return { nodes: [], edges: [], width: 640, height: 230 };
  }

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  groups.forEach((group, groupIndex) => {
    const y = 60 + groupIndex * 190;
    const startId = `start-${groupIndex}`;
    nodes.push({ id: startId, kind: "start", title: `开始：${group[0].context}`, x: 20, y });

    const happy = group.filter((scenario) => scenario.category === "happy");
    const branches = group.filter((scenario) => scenario.category !== "happy");
    happy.forEach((scenario, index) => {
      const x = 200 + index * 190;
      nodes.push({ id: scenario.reference, kind: "scenario", reference: scenario.reference, title: scenario.action, outcome: scenario.outcome, category: scenario.category, x, y });
      edges.push({ id: `${startId}-${scenario.reference}`, from: startId, to: scenario.reference });
    });

    branches.forEach((scenario, index) => {
      nodes.push({ id: scenario.reference, kind: "branch", reference: scenario.reference, title: scenario.action, outcome: scenario.outcome, category: scenario.category, x: 200 + index * 190, y: y + 90 });
      edges.push({ id: `${startId}-${scenario.reference}`, from: startId, to: scenario.reference });
    });
  });

  const endX = Math.max(...nodes.map((node) => node.x));
  return { nodes, edges, width: Math.max(640, endX + 180), height: groups.length * 190 + 40 };
}
