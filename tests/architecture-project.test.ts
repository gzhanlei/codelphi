import { describe, expect, it } from "vitest";
import { architectureProjectionId, componentWidth, projectArchitectureDocument } from "../lib/architecture/project";
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
    expect(document.components.find((component) => component.id === "github")?.pos[0]).toBeLessThan(document.components.find((component) => component.id === "api")!.pos[0]);
    expect(document.components.find((component) => component.id === "github")?.pos[1]).toBeGreaterThanOrEqual(80);
    expect(document.components.find((component) => component.id === "agent")?.pos[0]).toBe(document.components.find((component) => component.id === "api")?.pos[0]);
    expect(document.components.find((component) => component.id === "ui")?.pos[1]).toBeLessThan(document.components.find((component) => component.id === "api")!.pos[1]);
    expect(document.components.find((component) => component.id === "llm")?.pos[0]).toBeGreaterThan(document.components.find((component) => component.id === "api")!.pos[0]);
    expect(document.meta.quality_profile).toBe("standard");
    expect(document.meta.viewBox[0]).toBeGreaterThan(1000);
    expect(document.meta.viewBox[1]).toBeGreaterThan(300);
    expect(document.components.find((component) => component.id === "api")?.sublabel).toBe("cmd/api");
    expect(document.components.find((component) => component.id === "users")?.sublabel).toBe("user");
    expect(document.components.find((component) => component.id === "api")?.sources).toHaveLength(3);
    expect(document.components.find((component) => component.id === "api")?.sources?.map((source) => source.line)).toEqual([1, 2, 3]);
    expect(document.connections.find((connection) => connection.id === "schedule")?.variant).toBe("dashed");
    expect(document.connections.find((connection) => connection.id === "oauth")?.variant).toBe("security");
    expect(document.connections.find((connection) => connection.id === "http")?.variant).toBeUndefined();
    expect(document.connections.find((connection) => connection.id === "poll")?.variant).toBe("dashed");
    expect(document.connections.find((connection) => connection.id === "callback")?.variant).toBe("dashed");
    expect(document.connections.find((connection) => connection.id === "process")?.variant).toBeUndefined();
    const byId = new Map(document.components.map((component) => [component.id, component]));
    const center = (id: string) => {
      const component = byId.get(id)!;
      return { x: component.pos[0] + component.size[0] / 2, y: component.pos[1] + component.size[1] / 2 };
    };
    for (const connection of document.connections) {
      const path = [center(connection.from), ...(connection.via ?? []).map(([x, y]) => ({ x, y })), center(connection.to)];
      for (const [index, point] of path.slice(0, -1).entries()) {
        const next = path[index + 1];
        for (const component of document.components.filter((candidate) => candidate.id !== connection.from && candidate.id !== connection.to)) {
          const rect = { left: component.pos[0], right: component.pos[0] + component.size[0], top: component.pos[1], bottom: component.pos[1] + component.size[1] };
          const horizontal = point.y === next.y;
          const vertical = point.x === next.x;
          expect(horizontal || vertical).toBe(true);
          const hit = horizontal
            ? point.y > rect.top && point.y < rect.bottom && Math.max(point.x, next.x) > rect.left && Math.min(point.x, next.x) < rect.right
            : point.x > rect.left && point.x < rect.right && Math.max(point.y, next.y) > rect.top && Math.min(point.y, next.y) < rect.bottom;
          expect(hit, `${connection.id} crosses ${component.id}`).toBe(false);
        }
      }
    }
    expect(new Set(document.connections.map((connection) => connection.labelAt?.join(":"))).size).toBe(document.connections.length);
    expect(document).toMatchSnapshot();
  });

  it("keeps deterministic geometry for a minimal request and storage flow", () => {
    const facts: ArchitectureFactSet = {
      version: 1,
      revision,
      roots: ["users"],
      nodes: [node("users", "user"), node("api", "api"), node("db", "database")],
      edges: [
        { id: "request", from: "users", to: "api", kind: "http", label: "HTTPS", signalIds: [], evidence: [{ path: "api.ts", line: 1, detector: "test" }] },
        { id: "sql", from: "api", to: "db", kind: "sql", label: "SQL 读写", signalIds: [], evidence: [{ path: "db.ts", line: 1, detector: "test" }] },
      ],
      omissions: [],
    };
    expect(projectArchitectureDocument({ productName: "Product", productSlug: "product", owner: "owner", name: "repo", revision }, facts)).toMatchSnapshot();
  });

  it("normalizes projection ids and estimates component widths at exact boundaries", () => {
    const projected = architectureProjectionId("go:backend/cmd/server");
    expect(projected.startsWith("go-backend-cmd-server-")).toBe(true);
    expect(projected).toMatch(/[0-9a-f]{10}$/);
    expect(architectureProjectionId("::::").startsWith("node-")).toBe(true);
    expect(componentWidth("a".repeat(20))).toBe(184);
    expect(componentWidth("Ā".repeat(20))).toBe(284);
    expect(componentWidth("ÿ".repeat(20))).toBe(184);
    expect(componentWidth("a".repeat(40))).toBe(320);
  });

  it("maps unsafe fact ids to stable Archify ids and preserves endpoints", () => {
    const facts: ArchitectureFactSet = {
      version: 1,
      revision,
      roots: ["external:xpay"],
      nodes: [node("go:backend/cmd/server", "api"), node("external:xpay", "external")],
      edges: [{ id: "http:go:backend/cmd/remoteagent->go:backend/cmd/server:/api/worker/{id}/claim", from: "external:xpay", to: "go:backend/cmd/server", kind: "callback", label: "claim", signalIds: [], evidence: [{ path: "agent.go", line: 1, detector: "test" }] }],
      omissions: [],
    };
    const first = projectArchitectureDocument({ productName: "Product", productSlug: "product", owner: "owner", name: "repo", revision }, facts);
    const second = projectArchitectureDocument({ productName: "Product", productSlug: "product", owner: "owner", name: "repo", revision }, facts);
    expect(first).toEqual(second);
    for (const component of first.components) expect(component.id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    const root = first.components.find((component) => component.label === "external:xpay");
    expect(root).toBeDefined();
    const server = first.components.find((component) => component.label === "go:backend/cmd/server");
    expect(server).toBeDefined();
    expect(first.connections[0].from).toBe(root?.id);
    expect(first.connections[0].to).toBe(server?.id);
    expect(first.connections[0].id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });
});
