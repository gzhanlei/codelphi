import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint, type ElkShape } from "elkjs/lib/elk.bundled";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { FeatureFlowGraph, SemanticFlowNode } from "./semantic-feature-flow";
import type { ScenarioRow } from "./types";

const LAYOUT_PADDING = 40;

export interface PositionedSemanticFlowNode extends SemanticFlowNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedLabel {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RoutedSemanticFlowEdge = FeatureFlowGraph["edges"][number] & {
  points: ElkPoint[];
  labelPosition?: PositionedLabel;
};

export interface LayoutedFeatureFlow {
  nodes: PositionedSemanticFlowNode[];
  edges: RoutedSemanticFlowEdge[];
  width: number;
  height: number;
}

export type FeatureFlowNodeData = {
  title: string;
  kind: SemanticFlowNode["kind"];
  scenarios: ScenarioRow[];
};

export type FeatureFlowReactNode = Node<FeatureFlowNodeData, "feature">;
export type FeatureFlowEdgeData = {
  points: ElkPoint[];
  labelPosition?: PositionedLabel;
};

function characterWidth(character: string) {
  return character.codePointAt(0)! > 255 ? 2 : 1;
}

function displayWidth(value: string) {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

function lineCount(value: string, maxUnits = 36, cap = 3) {
  if (!value) return 1;
  let lines = 1;
  let width = 0;
  for (const character of value) {
    const next = characterWidth(character);
    if (width + next > maxUnits) {
      lines += 1;
      width = 0;
    }
    width += next;
  }
  return Math.min(cap, lines);
}

export function semanticNodeSize(node: SemanticFlowNode) {
  if (node.kind === "start") return { width: 144, height: 56 };
  return { width: 260, height: 44 + lineCount(node.title) * 20 };
}

function edgeLabelSize(label: string) {
  const lines = lineCount(label, 32, 2);
  return { width: Math.min(240, Math.max(70, displayWidth(label) * 5.5 + 16)), height: lines * 16 + 8 };
}

function center(node: PositionedSemanticFlowNode): ElkPoint {
  return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

function fallbackLabelPosition(points: ElkPoint[], size: { width: number; height: number }): PositionedLabel {
  const [start, end] = [points[0], points[points.length - 1]];
  return { ...size, x: (start.x + end.x) / 2 - size.width / 2, y: (start.y + end.y) / 2 - size.height / 2 };
}

function routedEdge(edge: FeatureFlowGraph["edges"][number], layout: ElkExtendedEdge | undefined, nodes: Map<string, PositionedSemanticFlowNode>): RoutedSemanticFlowEdge {
  const section = layout?.sections?.[0];
  const source = nodes.get(edge.from)!;
  const target = nodes.get(edge.to)!;
  const points = section
    ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({ x: point.x + LAYOUT_PADDING, y: point.y + LAYOUT_PADDING }))
    : [center(source), center(target)];
  let labelPosition: PositionedLabel | undefined;
  if (edge.label) {
    const size = edgeLabelSize(edge.label);
    const label = layout?.labels?.[0];
    labelPosition = label
      ? { x: (label.x ?? 0) + LAYOUT_PADDING, y: (label.y ?? 0) + LAYOUT_PADDING, width: label.width ?? size.width, height: label.height ?? size.height }
      : fallbackLabelPosition(points, size);
  }
  return { ...edge, points, labelPosition };
}

export async function layoutSemanticFeatureFlow(graph: FeatureFlowGraph): Promise<LayoutedFeatureFlow> {
  const elk = new ELK();
  const layout = await elk.layout({
    id: "semantic-feature-flow",
    width: 0,
    height: 0,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.edgeLabels.placement": "CENTER",
      "elk.spacing.nodeNode": "48",
      "elk.spacing.edgeLabel": "18",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
    },
    children: graph.nodes.map((node) => ({ id: node.id, ...semanticNodeSize(node) })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sources: [edge.from],
      targets: [edge.to],
      labels: edge.label ? [{ text: edge.label, ...edgeLabelSize(edge.label) }] : [],
    })),
  });
  const positions = new Map((layout.children ?? []).map((node) => [node.id, node]));
  const nodes: PositionedSemanticFlowNode[] = graph.nodes.map((node) => {
    const position = positions.get(node.id);
    const size = semanticNodeSize(node);
    return { ...node, x: (position?.x ?? 0) + LAYOUT_PADDING, y: (position?.y ?? 0) + LAYOUT_PADDING, ...size };
  });
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const layoutEdges = new Map((layout.edges ?? []).map((edge) => [edge.id, edge]));
  const edges = graph.edges.map((edge) => routedEdge(edge, layoutEdges.get(edge.id), nodesById));
  const width = Math.max(640, ...nodes.map((node) => node.x + node.width + LAYOUT_PADDING));
  const height = Math.max(320, ...nodes.map((node) => node.y + node.height + LAYOUT_PADDING));
  return { nodes, edges, width, height };
}

export function toReactFlowElements(layout: LayoutedFeatureFlow, scenarios: ScenarioRow[]) {
  const scenariosByReference = new Map(scenarios.map((scenario) => [scenario.reference, scenario]));
  const nodes: FeatureFlowReactNode[] = layout.nodes.map((node) => ({
    id: node.id,
    type: "feature",
    position: { x: node.x, y: node.y },
    data: {
      title: node.title,
      kind: node.kind,
      scenarios: node.scenarioRefs.map((reference) => scenariosByReference.get(reference)).filter((scenario) => scenario !== undefined),
    },
    style: { width: node.width, height: node.height },
  }));
  const edges: Edge<FeatureFlowEdgeData>[] = layout.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: "routed",
    label: edge.label,
    data: { points: edge.points, labelPosition: edge.labelPosition },
    className: `flow-react-edge ${edge.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    ariaLabel: edge.label ? `${edge.from} → ${edge.to}: ${edge.label}` : `${edge.from} → ${edge.to}`,
  }));
  return { nodes, edges };
}
