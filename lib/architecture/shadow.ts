import type { ArchitectureDocument } from "../architecture-draft";
import { architectureFactSetSchema, type ArchitectureEvidence, type ArchitectureFactSet, type EdgeFact, type NodeFact } from "./facts";
import { collectArchitectureSignals, type ArchitectureSignal, type ArchitectureSignalInventory } from "./signals";
import { evaluateArchitectureCoverage, type ArchitectureCoverage } from "./coverage";
import { analyzeArchitectureFacts } from "./extract";

type Component = ArchitectureDocument["components"][number];
type Connection = ArchitectureDocument["connections"][number];

interface LegacyShadowInput {
  revision: string;
  scope: ArchitectureSignalInventory["scope"];
  sources: Array<{ path: string; content: string }>;
  document?: ArchitectureDocument;
}

export interface ArchitectureShadow {
  version: 1;
  status: "completed" | "unavailable";
  scope: LegacyShadowInput["scope"] | "unavailable";
  signalCount: number;
  factCounts: { nodes: number; edges: number; roots: number } | null;
  coverage: ArchitectureCoverage | null;
}

const legacyKindByType: Partial<Record<Component["type"], NodeFact["kind"]>> = {
  frontend: "frontend",
  database: "database",
  cloud: "object-store",
  messagebus: "queue",
  backend: "api",
};

const legacyBackendKinds = [
  { pattern: /agent/i, kind: "agent" },
  { pattern: /worker|analysis/i, kind: "worker" },
] as const;

export function unavailableArchitectureShadow(scope: ArchitectureShadow["scope"], error?: string): ArchitectureShadow & { error?: string } {
  return { version: 1, status: "unavailable", scope, signalCount: 0, factCounts: null, coverage: null, ...(error === undefined ? {} : { error }) };
}

function legacyNodeKind(component: Component): NodeFact["kind"] {
  const mapped = legacyKindByType[component.type];
  const kind = component.id === "users" ? "user" : mapped === undefined ? "external" : mapped;
  const backendKind = legacyBackendKinds.find((rule) => rule.pattern.test(`${component.id} ${component.label}`));
  return kind === "api" && backendKind !== undefined ? backendKind.kind : kind;
}

function legacyEvidence(component: Component): ArchitectureEvidence[] {
  const sources = component.sources === undefined ? [] : component.sources;
  return sources.flatMap((source) => typeof source.line === "number"
    ? [{ path: source.path, line: source.line, detector: "legacy-architecture-document" }]
    : []);
}

function matchingSignalIds(signals: ArchitectureSignal[], component: Component) {
  const sources = component.sources === undefined ? [] : component.sources;
  const paths = new Set(sources.map((source) => source.path));
  return signals.filter((signal) => paths.has(signal.evidence.path)).map((signal) => signal.id).sort();
}

const legacyEdgeKinds = [
  { pattern: /poll|轮询|认领/i, kind: "poll" },
  { pattern: /schedule|定时/i, kind: "schedule" },
  { pattern: /upload|上传|\bPUT\b/i, kind: "upload" },
  { pattern: /download|下载/i, kind: "download" },
  { pattern: /oauth|sso|auth/i, kind: "oauth" },
  { pattern: /webhook|callback|推送/i, kind: "callback" },
  { pattern: /sql|mysql|database|数据库/i, kind: "sql" },
] as const;

function legacyEdgeKind(connection: Connection): EdgeFact["kind"] {
  const label = connection.label === undefined ? "" : connection.label;
  const match = legacyEdgeKinds.find((rule) => rule.pattern.test(label));
  return match === undefined ? "http" : match.kind;
}

function isLegacyRoot(node: NodeFact, edges: EdgeFact[]) {
  if (node.kind === "user") return true;
  if (node.kind !== "external") return false;
  const outgoing = edges.some((edge) => edge.from === node.id);
  const incoming = edges.some((edge) => edge.to === node.id);
  return outgoing && !incoming;
}

function legacyRoots(nodes: NodeFact[], edges: EdgeFact[]) {
  return nodes.filter((node) => isLegacyRoot(node, edges)).map((node) => node.id).sort();
}

export function legacyArchitectureFacts(revision: string, document: ArchitectureDocument, signals: ArchitectureSignal[]): ArchitectureFactSet {
  const nodes = document.components.map((component): NodeFact => ({
    id: component.id,
    kind: legacyNodeKind(component),
    label: component.label,
    signalIds: matchingSignalIds(signals, component),
    evidence: legacyEvidence(component),
  }));
  const edges = document.connections.map((connection): EdgeFact => ({
    id: connection.id,
    from: connection.from,
    to: connection.to,
    kind: legacyEdgeKind(connection),
    label: connection.label === undefined ? connection.id : connection.label,
    signalIds: [],
    evidence: [],
  }));
  return architectureFactSetSchema.parse({ version: 1, revision, roots: legacyRoots(nodes, edges), nodes, edges, omissions: [] });
}

export function createDirectArchitectureShadow(input: Omit<LegacyShadowInput, "document">): ArchitectureShadow {
  const { inventory, facts, coverage } = analyzeArchitectureFacts({ revision: input.revision, scope: input.scope }, input.sources);
  return {
    version: 1,
    status: "completed",
    scope: input.scope,
    signalCount: inventory.signals.length,
    factCounts: { nodes: facts.nodes.length, edges: facts.edges.length, roots: facts.roots.length },
    coverage,
  };
}

export function createLegacyArchitectureShadow(input: LegacyShadowInput): ArchitectureShadow {
  const inventory = collectArchitectureSignals({ revision: input.revision, scope: input.scope }, input.sources);
  if (!input.document) return { version: 1, status: "unavailable", scope: input.scope, signalCount: inventory.signals.length, factCounts: null, coverage: null };
  const facts = legacyArchitectureFacts(input.revision, input.document, inventory.signals);
  return {
    version: 1,
    status: "completed",
    scope: input.scope,
    signalCount: inventory.signals.length,
    factCounts: { nodes: facts.nodes.length, edges: facts.edges.length, roots: facts.roots.length },
    coverage: evaluateArchitectureCoverage(inventory, facts),
  };
}
