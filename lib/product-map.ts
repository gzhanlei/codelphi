import { buildFeatureConnections, type FeatureConnection, type ScenarioEvidenceRow } from "./feature-connections";
import { clipFlowLabel } from "./feature-flow";
import { buildFeatureTree, type FeatureTreeItem } from "./feature-tree";
import type { FeatureRow, ScenarioRow } from "./types";

/**
 * 产品行为地图（B3.2，docs/product-map-plan.md §4）：功能树节点 + B3 确定性连接边的产品级一页合成。
 * 只讲行为空间（功能/场景/共享证据面），不画模块/调用/部署结构——不复活架构图（非目标）。
 * 数据与规格页同源（同一份 features/scenarios 行，R5 口径漂移防线）；本模块为纯函数，无 DB 依赖。
 */

/** 地图上可见的连接边上限；超出按共享引用数降序截断并显式披露（不静默丢弃）。 */
export const MAP_MAX_EDGES = 60;

/** 默认在画布上显示的强连接条数；其余连线仍在 DOM 中，「显示全部连线」开关可见（降噪默认值）。 */
export const MAP_DEFAULT_EDGES = 20;

const NODE_W = 200;
const NODE_H = 64;
const CHILD_H = 52;
const CHILD_GAP = 10;
const COL_GAP = 48;
const BAND_GAP = 56;
const BAND_COLS = 4;
const CANVAS_PAD = 16;

export interface ProductMapNode {
  id: number;
  name: string;
  /** 卡片内截断后的显示名（与 tooltip 全名区分）。 */
  label: string;
  summary: string;
  kind: "feature" | "child";
  scenarioCount: number;
  /** 顶层功能的子功能数；子功能节点为 0。 */
  childCount: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ProductMapEdge {
  id: string;
  sourceId: number;
  sourceName: string;
  targetId: number;
  targetName: string;
  /** B3 连接携带的共享证据文件（每条连接前 5，按共享场景引用数排序）。 */
  sharedFiles: FeatureConnection["sharedFiles"];
  /** 排序权重：共享文件两侧场景引用总数。 */
  weight: number;
  /** 前 MAP_DEFAULT_EDGES 条强连接默认显示；其余仍渲染在 DOM，由「显示全部连线」开关展开。 */
  visible: boolean;
}

export interface ProductMapStats {
  featureCount: number;
  topLevelCount: number;
  childCount: number;
  scenarioCount: number;
  edgeCount: number;
  truncatedEdgeCount: number;
  /** 默认显示的强连接数（≤ MAP_DEFAULT_EDGES）。 */
  visibleEdgeCount: number;
}

export interface ProductMap {
  width: number;
  height: number;
  nodes: ProductMapNode[];
  edges: ProductMapEdge[];
  stats: ProductMapStats;
}

function featureNameLookup(features: FeatureRow[]) {
  return new Map(features.map((feature) => [feature.id, feature.name]));
}

/** 组装 B3 连接的输入行：只保留功能仍存在的场景（与规格页同源同过滤）。 */
function connectionRows(features: FeatureRow[], scenarios: ScenarioRow[]): ScenarioEvidenceRow[] {
  const names = featureNameLookup(features);
  return scenarios
    .filter((scenario) => names.has(scenario.featureId))
    .map((scenario) => ({ id: scenario.id, featureId: scenario.featureId, featureName: names.get(scenario.featureId)!, reference: scenario.reference, evidence: scenario.evidence }));
}

/** B3 连接按 feature 双向输出；按无序对去重成一条边（visible 稍后统一标记）。 */
function uniqueEdges(entries: ReturnType<typeof buildFeatureConnections>): ProductMapEdge[] {
  const seen = new Set<string>();
  const edges: ProductMapEdge[] = [];
  for (const entry of entries) {
    for (const connection of entry.connections) {
      const key = [connection.sourceFeatureId, connection.targetFeatureId].sort((a, b) => a - b).join("-");
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({
        id: key,
        sourceId: connection.sourceFeatureId,
        sourceName: connection.sourceFeatureName,
        targetId: connection.targetFeatureId,
        targetName: connection.targetFeatureName,
        sharedFiles: connection.sharedFiles,
        weight: connection.sharedFiles.reduce((sum, file) => sum + file.sourceScenarios.length + file.targetScenarios.length, 0),
        visible: false,
      });
    }
  }
  return edges;
}

/**
 * 聚簇排序：按顶层功能子树间的连接权重做贪心链，强关联功能相邻落位，减少连线交叉。
 * 起点取最强连接对，之后每步把「与链上已有功能权重之和最大」的功能接到链尾；
 * 权重并列取 id 最小者，全程确定性。无连接的功能保持名称序收尾。
 */
function clusterOrder(tree: FeatureTreeItem[], edges: ProductMapEdge[]): FeatureTreeItem[] {
  if (tree.length <= 2) return tree;
  const rootOf = new Map<number, number>();
  for (const item of tree) {
    rootOf.set(item.id, item.id);
    for (const child of item.children) rootOf.set(child.id, item.id);
  }
  const pairWeight = new Map<string, number>();
  for (const edge of edges) {
    const a = rootOf.get(edge.sourceId);
    const b = rootOf.get(edge.targetId);
    if (a === undefined || b === undefined || a === b) continue;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    pairWeight.set(key, (pairWeight.get(key) ?? 0) + edge.weight);
  }
  if (pairWeight.size === 0) return tree;
  let start: [number, number] | null = null;
  let startWeight = -1;
  for (const [key, weight] of pairWeight) {
    if (weight > startWeight) {
      const [a, b] = key.split("-").map(Number);
      start = [a, b];
      startWeight = weight;
    }
  }
  const byId = new Map(tree.map((item) => [item.id, item]));
  const chain = [start![0], start![1]];
  const remaining = new Set(tree.map((item) => item.id));
  remaining.delete(start![0]);
  remaining.delete(start![1]);
  const weightToChain = (id: number) => {
    let sum = 0;
    for (const member of chain) {
      const key = id < member ? `${id}-${member}` : `${member}-${id}`;
      sum += pairWeight.get(key) ?? 0;
    }
    return sum;
  };
  while (remaining.size > 0) {
    let pick: number | null = null;
    let pickWeight = -1;
    for (const id of remaining) {
      const weight = weightToChain(id);
      if (weight > pickWeight || (weight === pickWeight && pick !== null && id < pick)) {
        pick = id;
        pickWeight = weight;
      }
    }
    chain.push(pick!);
    remaining.delete(pick!);
  }
  return chain.map((id) => byId.get(id)!);
}

function layoutTree(tree: FeatureTreeItem[], scenarioCountByFeature: Map<number, number>): { nodes: ProductMapNode[]; height: number } {
  const nodes: ProductMapNode[] = [];
  const columns = tree.map((feature) => {
    const children = feature.children;
    const columnHeight = NODE_H + (children.length > 0 ? CHILD_GAP + children.length * CHILD_H + (children.length - 1) * CHILD_GAP : 0);
    return { feature, children, columnHeight };
  });
  const bands: (typeof columns)[] = [];
  for (let index = 0; index < columns.length; index += BAND_COLS) bands.push(columns.slice(index, index + BAND_COLS));

  let y = CANVAS_PAD;
  for (const band of bands) {
    const bandHeight = Math.max(...band.map((column) => column.columnHeight));
    band.forEach((column, columnIndex) => {
      const x = CANVAS_PAD + columnIndex * (NODE_W + COL_GAP);
      nodes.push({
        id: column.feature.id,
        name: column.feature.name,
        label: clipFlowLabel(column.feature.name, 16),
        summary: column.feature.summary,
        kind: "feature",
        scenarioCount: scenarioCountByFeature.get(column.feature.id) ?? 0,
        childCount: column.children.length,
        x,
        y,
        w: NODE_W,
        h: NODE_H,
      });
      column.children.forEach((child, childIndex) => {
        nodes.push({
          id: child.id,
          name: child.name,
          label: clipFlowLabel(child.name, 16),
          summary: child.summary,
          kind: "child",
          scenarioCount: scenarioCountByFeature.get(child.id) ?? 0,
          childCount: 0,
          x,
          y: y + NODE_H + CHILD_GAP + childIndex * (CHILD_H + CHILD_GAP),
          w: NODE_W,
          h: CHILD_H,
        });
      });
    });
    y += bandHeight + BAND_GAP;
  }
  return { nodes, height: y - BAND_GAP + CANVAS_PAD };
}

/**
 * 确定性产品地图布局：顶层功能按连接强度聚簇分带（每带 4 列），子功能纵向挂在父功能下；
 * 连接边按共享引用数降序取前 MAP_MAX_EDGES，其中前 MAP_DEFAULT_EDGES 条默认显示，截断数显式进 stats。
 */
export function buildProductMap(features: FeatureRow[], scenarios: ScenarioRow[]): ProductMap {
  const scenarioCountByFeature = new Map<number, number>();
  for (const scenario of scenarios) scenarioCountByFeature.set(scenario.featureId, (scenarioCountByFeature.get(scenario.featureId) ?? 0) + 1);

  const rankedEdges = uniqueEdges(buildFeatureConnections(connectionRows(features, scenarios)));
  rankedEdges.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const tree = clusterOrder(buildFeatureTree(features), rankedEdges);
  const width = CANVAS_PAD * 2 + Math.min(tree.length, BAND_COLS) * NODE_W + Math.max(Math.min(tree.length, BAND_COLS) - 1, 0) * COL_GAP;
  const { nodes, height } = layoutTree(tree, scenarioCountByFeature);

  const allEdges = rankedEdges.slice(0, MAP_MAX_EDGES);
  allEdges.forEach((edge, index) => { edge.visible = index < MAP_DEFAULT_EDGES; });

  return {
    width: Math.max(width, 620),
    height: Math.max(height, 200),
    nodes,
    edges: allEdges,
    stats: {
      featureCount: features.length,
      topLevelCount: tree.length,
      childCount: features.length - tree.length,
      scenarioCount: scenarios.length,
      edgeCount: rankedEdges.length,
      truncatedEdgeCount: Math.max(rankedEdges.length - allEdges.length, 0),
      visibleEdgeCount: Math.min(allEdges.length, MAP_DEFAULT_EDGES),
    },
  };
}
