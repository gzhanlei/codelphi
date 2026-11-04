import { describe, expect, it } from "vitest";
import { projectArchitectureDocument } from "../lib/architecture/project";
import type { ArchitectureFactSet, NodeFact } from "../lib/architecture/facts";

const revision = "13157624fb0d8b63e5072049c94824d4b6d2e609";
const node = (id: string, kind: NodeFact["kind"]): NodeFact => ({
  id,
  kind,
  label: id,
  signalIds: [],
  evidence: kind === "user" ? [] : [1, 2, 3, 4].map((line) => ({ path: `${id}.ts`, line, detector: "test" })),
});

describe("architecture fact projection", () => {
  it("maps every node role and external event root without repository templates", () => {
    const nodes = [
      node("users", "user"), node("ui", "frontend"), node("api", "api"), node("worker", "worker"), node("agent", "agent"),
      node("db", "database"), node("cos", "object-store"), node("queue", "queue"), node("github", "external"), node("llm", "external"),
    ];
    const facts: ArchitectureFactSet = {
      version: 1,
      revision,
      roots: ["users", "github"],
      nodes: nodes.map((node) => node.id === "api" ? { ...node, runtimeUnit: "cmd/api" } : node),
      edges: [
        { id: "schedule", from: "api", to: "worker", kind: "schedule", label: "after", signalIds: [], evidence: [{ path: "api.ts", line: 1, detector: "test" }] },
        { id: "oauth", from: "api", to: "github", kind: "oauth", label: "OAuth", signalIds: [], evidence: [{ path: "api.ts", line: 1, detector: "test" }] },
        { id: "http", from: "ui", to: "api", kind: "http", label: "HTTPS", signalIds: [], evidence: [{ path: "ui.ts", line: 1, detector: "test" }] },
        { id: "poll", from: "worker", to: "db", kind: "poll", label: "poll", signalIds: [], evidence: [{ path: "worker.ts", line: 1, detector: "test" }] },
        { id: "callback", from: "github", to: "api", kind: "callback", label: "push", signalIds: [], evidence: [{ path: "github.ts", line: 1, detector: "test" }] },
        { id: "process", from: "agent", to: "llm", kind: "process", label: "CLI", signalIds: [], evidence: [{ path: "agent.ts", line: 1, detector: "test" }] },
      ],
      omissions: [],
    };
    const document = projectArchitectureDocument({ productName: "Product", productSlug: "product", owner: "owner", name: "repo", revision }, facts);
    expect(Object.fromEntries(document.components.map((component) => [component.id, component.type]))).toEqual({
      users: "external", ui: "frontend", api: "backend", worker: "backend", agent: "backend", db: "database", cos: "cloud", queue: "messagebus", github: "external", llm: "external",
    });
    expect(document.components.find((component) => component.id === "github")?.pos[0]).toBe(40);
    expect(document.components.find((component) => component.id === "github")?.pos[1]).toBe(200);
    expect(document.components.find((component) => component.id === "agent")?.pos[1]).toBe(200);
    expect(document.components.find((component) => component.id === "ui")?.pos[1]).toBe(60);
    expect(document.components.find((component) => component.id === "llm")?.pos[0]).toBe(1090);
    expect(document.meta.viewBox).toEqual([1350, 484]);
    expect(document.components.find((component) => component.id === "api")?.sublabel).toBe("cmd/api");
    expect(document.components.find((component) => component.id === "users")?.sublabel).toBe("user");
    expect(document.components.find((component) => component.id === "api")?.sources).toHaveLength(3);
    expect(document.connections.find((connection) => connection.id === "schedule")?.variant).toBe("dashed");
    expect(document.connections.find((connection) => connection.id === "oauth")?.variant).toBe("security");
    expect(document.connections.find((connection) => connection.id === "http")?.variant).toBeUndefined();
    expect(document.connections.find((connection) => connection.id === "poll")?.variant).toBe("dashed");
    expect(document.connections.find((connection) => connection.id === "callback")?.variant).toBe("dashed");
    expect(document.connections.find((connection) => connection.id === "process")?.variant).toBeUndefined();
  });
});
