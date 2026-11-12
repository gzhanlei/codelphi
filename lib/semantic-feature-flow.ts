import { createHash } from "node:crypto";
import { z } from "zod";
import type { SpecScenario } from "./spec-diff";

const scenarioReferenceSchema = z.string().min(1).max(32);
const nodeSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(["start", "action", "decision", "error", "external", "waiting", "end"]),
  title: z.string().trim().min(1).max(300),
  scenarioRefs: z.array(scenarioReferenceSchema).max(40),
});
const edgeSchema = z.object({
  id: z.string().min(1).max(80),
  from: z.string().min(1).max(64),
  to: z.string().min(1).max(64),
  kind: z.enum(["sequence", "branch", "retry"]),
  label: z.string().trim().min(1).max(300).optional(),
  scenarioRefs: z.array(scenarioReferenceSchema).min(1).max(40),
});
const graphSchema = z.object({
  entryNodeIds: z.array(z.string().min(1).max(64)).min(1),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  excludedScenarios: z.array(z.object({
    reference: scenarioReferenceSchema,
    reason: z.enum(["documentary", "duplicate", "unsupported", "out-of-scope"]),
  })).max(40),
});

export type SemanticFlowNode = z.infer<typeof nodeSchema>;
export type SemanticFlowEdge = z.infer<typeof edgeSchema>;
export type ExcludedScenario = z.infer<typeof graphSchema>["excludedScenarios"][number];
export type FeatureFlowGraph = z.infer<typeof graphSchema>;

/**
 * 入口上限：入口=独立子流程的起点（如 MFA 的启用/验证/恢复），不是逐场景一个。
 * 超过上限通常说明模型在退化扇出，或功能本身内聚性不足（应拆分功能）。
 * 与 feature-flow-generation 的提示词共享同一常量。
 */
export const FEATURE_FLOW_MAX_ENTRIES = 8;

export class FlowValidationError extends Error {
  constructor(public readonly code: string, public readonly subjectId?: string) {
    super(subjectId ? `${code}: ${subjectId}` : code);
    this.name = "FlowValidationError";
  }
}

function normalized(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function scenarioFingerprint(scenarios: SpecScenario[]) {
  const rows = scenarios.map((scenario) => ({
    reference: scenario.reference,
    category: scenario.category,
    context: normalized(scenario.context),
    action: normalized(scenario.action),
    outcome: normalized(scenario.outcome),
    step: scenario.step ?? null,
    source: scenario.source ?? "generated",
  })).sort((a, b) => a.reference.localeCompare(b.reference));
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function duplicateIds(ids: string[]) {
  return ids.filter((id, index) => ids.indexOf(id) !== index);
}

function retryEvidence(scenarios: SpecScenario[]) {
  return scenarios.some((scenario) => /重试|retry|返回上一步|回退|循环/i.test(`${scenario.context} ${scenario.action} ${scenario.outcome}`));
}

function assertAcyclic(graph: FeatureFlowGraph) {
  const adjacency = new Map(graph.nodes.map((node) => [node.id, graph.edges.filter((edge) => edge.kind !== "retry" && edge.from === node.id).map((edge) => edge.to)]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new FlowValidationError("UNEXPECTED_CYCLE", id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of graph.nodes) visit(node.id);
}

function hasMainChain(graph: FeatureFlowGraph) {
  const executable = new Set(graph.nodes.filter((node) => ["action", "decision", "external", "waiting"].includes(node.kind)).map((node) => node.id));
  const longest = new Map<string, number>();
  const visit = (id: string): number => {
    const cached = longest.get(id);
    if (cached !== undefined) return cached;
    const own = executable.has(id) ? 1 : 0;
    const next = Math.max(0, ...graph.edges.filter((edge) => edge.kind !== "retry" && edge.from === id).map((edge) => visit(edge.to)));
    const result = own + next;
    longest.set(id, result);
    return result;
  };
  return graph.entryNodeIds.some((id) => visit(id) >= 2);
}

export function validateFeatureFlowGraph(graph: unknown, scenarios: SpecScenario[]): FeatureFlowGraph {
  const parsed = graphSchema.safeParse(graph);
  if (!parsed.success) throw new FlowValidationError("INVALID_GRAPH_SHAPE");
  const value = parsed.data;
  if (value.nodes.length > 24) throw new FlowValidationError("TOO_MANY_NODES");
  if (value.edges.length > 48) throw new FlowValidationError("TOO_MANY_EDGES");
  if (value.entryNodeIds.length > FEATURE_FLOW_MAX_ENTRIES) throw new FlowValidationError("TOO_MANY_ENTRIES");

  const duplicateNode = duplicateIds(value.nodes.map((node) => node.id))[0];
  if (duplicateNode) throw new FlowValidationError("DUPLICATE_NODE_ID", duplicateNode);
  const duplicateEdge = duplicateIds(value.edges.map((edge) => edge.id))[0];
  if (duplicateEdge) throw new FlowValidationError("DUPLICATE_EDGE_ID", duplicateEdge);
  if (new Set(value.entryNodeIds).size !== value.entryNodeIds.length) throw new FlowValidationError("DUPLICATE_ENTRY_ID");

  const nodesById = new Map(value.nodes.map((node) => [node.id, node]));
  const scenariosByReference = new Map(scenarios.map((scenario) => [scenario.reference, scenario]));
  const assertReference = (reference: string) => {
    if (!scenariosByReference.has(reference)) throw new FlowValidationError("UNKNOWN_SCENARIO_REFERENCE", reference);
  };
  for (const node of value.nodes) {
    if (node.kind !== "start" && node.scenarioRefs.length === 0) throw new FlowValidationError("NODE_EVIDENCE_MISSING", node.id);
    node.scenarioRefs.forEach(assertReference);
  }
  for (const edge of value.edges) {
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) throw new FlowValidationError("UNKNOWN_EDGE_ENDPOINT", edge.id);
    edge.scenarioRefs.forEach(assertReference);
    if (edge.kind === "branch" && !edge.label) throw new FlowValidationError("BRANCH_LABEL_MISSING", edge.id);
    if (edge.kind === "retry" && !retryEvidence(edge.scenarioRefs.map((reference) => scenariosByReference.get(reference)!))) {
      throw new FlowValidationError("RETRY_EVIDENCE_MISSING", edge.id);
    }
    const source = nodesById.get(edge.from)!;
    const target = nodesById.get(edge.to)!;
    if (source.kind === "start" && target.kind === "error" && edge.kind !== "branch") {
      throw new FlowValidationError("UNCONDITIONAL_ERROR_ENTRY", edge.id);
    }
  }
  for (const entryId of value.entryNodeIds) {
    if (nodesById.get(entryId)?.kind !== "start") throw new FlowValidationError("INVALID_ENTRY_NODE", entryId);
  }
  const outgoingEntries = value.edges.filter((edge) => nodesById.get(edge.from)?.kind === "start");
  if (outgoingEntries.length > FEATURE_FLOW_MAX_ENTRIES) throw new FlowValidationError("TOO_MANY_ENTRIES");

  const excluded = new Set(value.excludedScenarios.map((scenario) => scenario.reference));
  for (const node of value.nodes) {
    if (node.scenarioRefs.some((reference) => excluded.has(reference))) throw new FlowValidationError("EXCLUDED_SCENARIO_IN_GRAPH", node.id);
  }
  value.excludedScenarios.forEach((scenario) => assertReference(scenario.reference));

  const reachable = new Set<string>();
  const queue = [...value.entryNodeIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const edge of value.edges) if (edge.from === id) queue.push(edge.to);
  }
  const unreachable = value.nodes.find((node) => !reachable.has(node.id));
  if (unreachable) throw new FlowValidationError("UNREACHABLE_NODE", unreachable.id);

  assertAcyclic(value);
  if (!hasMainChain(value)) throw new FlowValidationError("MAIN_CHAIN_MISSING");
  return value;
}
