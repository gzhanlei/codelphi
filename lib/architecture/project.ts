import { architectureDocumentSchema, type ArchitectureDocument, type ArchitectureDraftInput } from "../architecture-draft";
import { getCodeHostingAdapter } from "../code-hosting/registry";
import type { ArchitectureFactSet, NodeFact } from "./facts";
import { uniqueEvidence } from "./source";

type Component = ArchitectureDocument["components"][number];

const componentTypes: Record<NodeFact["kind"], Component["type"]> = {
  user: "external",
  frontend: "frontend",
  api: "backend",
  worker: "backend",
  agent: "backend",
  database: "database",
  "object-store": "cloud",
  queue: "messagebus",
  external: "external",
};

function componentType(node: NodeFact): Component["type"] {
  return componentTypes[node.kind];
}

const columns: Record<NodeFact["kind"], number> = {
  user: 0,
  frontend: 1,
  api: 2,
  worker: 3,
  agent: 3,
  database: 4,
  "object-store": 4,
  queue: 4,
  external: 5,
};

function column(node: NodeFact, roots: Set<string>) {
  return node.kind === "external" && roots.has(node.id) ? 0 : columns[node.kind];
}

function components(facts: ArchitectureFactSet) {
  const roots = new Set(facts.roots);
  const rows = new Map<number, number>();
  return facts.nodes.map((node): Component => {
    const col = column(node, roots);
    const previousRow = rows.get(col);
    const row = previousRow === undefined ? 0 : previousRow;
    rows.set(col, row + 1);
    return {
      id: node.id,
      type: componentType(node),
      label: node.label,
      sublabel: node.runtimeUnit === undefined ? node.kind : node.runtimeUnit,
      pos: [40 + col * 210, 60 + row * 140],
      size: [180, 64],
      sources: uniqueEvidence(node.evidence).slice(0, 3).map((item) => ({ path: item.path, line: item.line })),
    };
  });
}

const dashedEdgeKinds = new Set(["poll", "schedule", "callback"]);

export function projectArchitectureDocument(input: Pick<ArchitectureDraftInput, "productName" | "productSlug" | "owner" | "name" | "provider" | "revision">, facts: ArchitectureFactSet): ArchitectureDocument {
  const adapter = getCodeHostingAdapter(input.provider);
  const projected = components(facts);
  const maxX = Math.max(...projected.map((component) => component.pos[0] + component.size[0]), 960);
  const maxY = Math.max(...projected.map((component) => component.pos[1] + component.size[1]), 240);
  return architectureDocumentSchema.parse({
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: `${input.productName} 系统架构`,
      output: `${input.productSlug}-architecture.html`,
      locale: "zh-CN",
      quality_profile: "showcase",
      repository: { url: adapter.repositoryUrl(input), provider: adapter.provider, revision: input.revision },
      viewBox: [maxX + 80, maxY + 80],
    },
    components: projected,
    connections: facts.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      label: edge.label,
      variant: edge.kind === "oauth" ? "security" : dashedEdgeKinds.has(edge.kind) ? "dashed" : undefined,
    })),
  });
}
