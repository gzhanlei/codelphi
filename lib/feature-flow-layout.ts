import ELK from "elkjs/lib/elk.bundled";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import type { FeatureFlow, FlowNode } from "./feature-flow";
import type { ScenarioRow } from "./types";

export const FLOW_NODE_SIZE = {
  start: { width: 144, height: 56 },
  scenario: { width: 240, height: 88 },
  branch: { width: 240, height: 88 },
} as const;

const LAYOUT_PADDING = 40;

export type FeatureFlowNodeData = {
  title: string;
  reference?: string;
  outcome?: string;
  kind: FlowNode["kind"];
  category?: FlowNode["category"];
  scenarios: ScenarioRow[];
};

export type FeatureFlowReactNode = Node<FeatureFlowNodeData, "feature">;

export function flowNodeSize(node: FlowNode) {
  return FLOW_NODE_SIZE[node.kind];
}

export function toReactFlowElements(flow: FeatureFlow, scenarios: ScenarioRow[]) {
  const scenariosByReference = new Map(scenarios.map((scenario) => [scenario.reference, scenario]));
  const flowNodesById = new Map(flow.nodes.map((node) => [node.id, node]));
  const nodes: FeatureFlowReactNode[] = flow.nodes.map((node) => ({
    id: node.id,
    type: "feature",
    position: { x: node.x, y: node.y },
    data: {
      title: node.title,
      reference: node.reference,
      outcome: node.outcome,
      kind: node.kind,
      category: node.category,
      scenarios: node.reference ? [scenariosByReference.get(node.reference)].filter((scenario) => scenario !== undefined) : [],
    },
    style: flowNodeSize(node),
  }));
  const edges: Edge[] = flow.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: flow.presentation === "fanout" ? "fanout" : "smoothstep",
    label: edge.label,
    className: flowNodesById.get(edge.to)?.kind === "branch" ? "flow-react-edge branch" : "flow-react-edge",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    ariaLabel: `${flowNodesById.get(edge.from)?.title ?? edge.from} → ${flowNodesById.get(edge.to)?.title ?? edge.to}`,
  }));
  return { nodes, edges };
}

function packSteplessFanout(flow: FeatureFlow): FeatureFlow | null {
  const scenarios = flow.nodes.filter((node) => node.kind !== "start");
  if (scenarios.length < 8 || flow.edges.length !== scenarios.length || flow.edges.some((edge) => edge.from !== "start")) return null;

  const columns = 4;
  const columnStride = 280;
  const rowStride = 152;
  const firstRowY = LAYOUT_PADDING + FLOW_NODE_SIZE.start.height + 96;
  const width = LAYOUT_PADDING * 2 + columns * FLOW_NODE_SIZE.scenario.width + (columns - 1) * 40;
  const rows = Math.ceil(scenarios.length / columns);
  const start = flow.nodes.find((node) => node.kind === "start")!;
  return {
    ...flow,
    presentation: "fanout",
    nodes: [
      { ...start, x: (width - FLOW_NODE_SIZE.start.width) / 2, y: LAYOUT_PADDING },
      ...scenarios.map((node, index) => ({
        ...node,
        x: LAYOUT_PADDING + (index % columns) * columnStride,
        y: firstRowY + Math.floor(index / columns) * rowStride,
      })),
    ],
    width,
    height: firstRowY + rows * rowStride - 64 + LAYOUT_PADDING,
  };
}

export async function layoutFeatureFlow(flow: FeatureFlow): Promise<FeatureFlow> {
  if (flow.nodes.length === 0) return flow;
  const fanout = packSteplessFanout(flow);
  if (fanout) return fanout;

  const elk = new ELK();
  const layout = await elk.layout({
    id: "feature-flow",
    width: 0,
    height: 0,
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "40",
      "elk.layered.spacing.nodeNodeBetweenLayers": "64",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: flow.nodes.map((node) => ({ id: node.id, ...flowNodeSize(node) })),
    edges: flow.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  });

  const positions = new Map((layout.children ?? []).map((node) => [node.id, node]));
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const position = positions.get(node.id);
      return {
        ...node,
        x: (position?.x ?? 0) + LAYOUT_PADDING,
        y: (position?.y ?? 0) + LAYOUT_PADDING,
      };
    }),
    width: (layout.width ?? 0) + LAYOUT_PADDING * 2,
    height: (layout.height ?? 0) + LAYOUT_PADDING * 2,
  };
}
