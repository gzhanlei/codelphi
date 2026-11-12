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
  /** 情境条件标注：每个情境组从「开始工作」入口出发的第一条边携带该组的 context。 */
  label?: string;
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
  /** 是否存在可画的结构：任一 step 主链（顺序结构）或多于一个情境组（条件分支结构）。 */
  structured: boolean;
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

function validStep(scenario: SpecScenario): number | null {
  return typeof scenario.step === "number" && Number.isInteger(scenario.step) && scenario.step >= 1 && scenario.step <= 40 ? scenario.step : null;
}

const NODE_HEIGHT = 70;
const BRANCH_ROW_OFFSET = 90;
const LEAF_BAND_EXTRA = 30;
const TOP_MARGIN = 60;
const CHAIN_STRIDE = 190;
const STACK_STRIDE = 80;
const STACK_AFTER_CHAIN = 90;
const STACK_AFTER_ATTACH_ROW = 170;
const LEFT_COLUMN = 200;
const ENTRY_ID = "start";

/** 组内已归属分支（有 step 且链上存在该步骤）数量。 */
function attachBranchCount(group: SpecScenario[]) {
  const steps = new Set(group.filter((scenario) => scenario.category === "happy" && validStep(scenario) !== null).map((scenario) => validStep(scenario)!));
  return group.filter((scenario) => scenario.category !== "happy" && validStep(scenario) !== null && steps.has(validStep(scenario)!)).length;
}

function bandHeight(group: SpecScenario[]) {
  const chainLength = group.filter((scenario) => scenario.category === "happy" && validStep(scenario) !== null).length;
  if (chainLength === 0) {
    // 无链组：全部场景竖直堆叠。
    return (group.length - 1) * STACK_STRIDE + NODE_HEIGHT + LEAF_BAND_EXTRA;
  }
  const attachRow = attachBranchCount(group) > 0 ? BRANCH_ROW_OFFSET + NODE_HEIGHT : 0;
  const stackCount = group.length - chainLength - attachBranchCount(group);
  const stackBottom = stackCount > 0 ? (attachRow > 0 ? STACK_AFTER_ATTACH_ROW : STACK_AFTER_CHAIN) + (stackCount - 1) * STACK_STRIDE + NODE_HEIGHT : 0;
  return Math.max(NODE_HEIGHT, attachRow, stackBottom) + LEAF_BAND_EXTRA;
}

/** 结构判定：多于一组情境（条件分支结构）或任一组有 step 主链（顺序结构）。两者皆无时流程图退化为清单，不渲染。 */
export function hasFlowStructure(scenarios: SpecScenario[]): boolean {
  const groups = contextGroups(scenarios);
  if (groups.length > 1) return true;
  return groups.some((group) => group.some((scenario) => scenario.category === "happy" && validStep(scenario) !== null));
}

export function buildFeatureFlow(scenarios: SpecScenario[]): FeatureFlow {
  const groups = contextGroups(scenarios);
  if (groups.length === 0) {
    return { nodes: [], edges: [], width: 640, height: 230, structured: false };
  }

  const bandOffsets: number[] = [];
  let cursor = TOP_MARGIN;
  for (const group of groups) {
    bandOffsets.push(cursor);
    cursor += bandHeight(group);
  }
  const height = cursor + 30;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  // 入口置顶：一条竖直干线沿节点列左侧下行，各场景用短支线接入（见组件 EntryEdgeBundle）。
  const entry: FlowNode = { id: ENTRY_ID, kind: "start", title: "开始工作", x: 20, y: TOP_MARGIN };
  nodes.push(entry);

  groups.forEach((group, groupIndex) => {
    const y = bandOffsets[groupIndex];
    let labeled = false;
    const connect = (to: string) => {
      edges.push({ id: `${ENTRY_ID}-${to}`, from: ENTRY_ID, to, label: labeled ? undefined : group[0].context });
      labeled = true;
    };
    const pushScenario = (scenario: SpecScenario, kind: FlowNode["kind"], x: number, nodeY: number) => {
      nodes.push({ id: scenario.reference, kind, reference: scenario.reference, title: scenario.action, outcome: scenario.outcome, category: scenario.category, x, y: nodeY });
    };

    const happy = group.filter((scenario) => scenario.category === "happy");
    const branches = group.filter((scenario) => scenario.category !== "happy");

    // W-DECISION 最小序列版（docs/w-decision-scenario-sequence-plan.md §4）：
    // 有 step 的 happy 场景按 step 升序连成主链 开始工作→1→2→…；分支可标注归属步骤（弧线下垂）。
    // 呈现层升级（2026-11-12）：情境从每行独立「开始」节点改为入口边上的条件标注，全图单一「开始工作」入口；
    // 横排只保留给有 step 证据的顺序链，其余场景（无 step 的 happy 与未归属分支）一律在左列竖直堆叠，
    // 位置并列不表示先后，入口干线直达每层、互不穿越节点框。
    const stepped = happy.filter((scenario) => validStep(scenario) !== null).sort((a, b) => validStep(a)! - validStep(b)! || a.reference.localeCompare(b.reference));
    const unstepped = happy.filter((scenario) => validStep(scenario) === null);
    const chain: Array<{ node: FlowNode; step: number }> = stepped.map((scenario, index) => ({
      node: { id: scenario.reference, kind: "scenario" as const, reference: scenario.reference, title: scenario.action, outcome: scenario.outcome, category: scenario.category, x: LEFT_COLUMN + index * CHAIN_STRIDE, y },
      step: validStep(scenario)!,
    }));
    chain.forEach(({ node }) => nodes.push(node));

    const attachBranches = branches.filter((scenario) => validStep(scenario) !== null && chain.some((chainEntry) => chainEntry.step === validStep(scenario)));
    const looseBranches = branches.filter((scenario) => !attachBranches.includes(scenario));
    const stack = [...unstepped, ...looseBranches];
    const stackY0 = chain.length === 0 ? y : y + (attachBranches.length > 0 ? STACK_AFTER_ATTACH_ROW : STACK_AFTER_CHAIN);

    if (chain.length > 0) {
      connect(chain[0].node.id);
      for (let index = 1; index < chain.length; index += 1) {
        edges.push({ id: `${chain[index - 1].node.id}-${chain[index].node.id}`, from: chain[index - 1].node.id, to: chain[index].node.id });
      }
      attachBranches.forEach((scenario, index) => {
        const attachNode = chain.find((chainEntry) => chainEntry.step === validStep(scenario))!.node;
        pushScenario(scenario, "branch", LEFT_COLUMN + index * CHAIN_STRIDE, y + BRANCH_ROW_OFFSET);
        edges.push({ id: `${attachNode.id}-${scenario.reference}`, from: attachNode.id, to: scenario.reference });
      });
    }
    stack.forEach((scenario, index) => {
      pushScenario(scenario, scenario.category === "happy" ? "scenario" : "branch", LEFT_COLUMN, stackY0 + index * STACK_STRIDE);
      connect(scenario.reference);
    });
  });

  const endX = Math.max(...nodes.map((node) => node.x));
  return { nodes, edges, width: Math.max(640, endX + 180), height, structured: hasFlowStructure(scenarios) };
}
