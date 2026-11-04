import { describe, expect, it } from "vitest";
import { buildArchitectureDocument } from "../lib/architecture-generic";
import { createLegacyArchitectureShadow, legacyArchitectureFacts } from "../lib/architecture/shadow";
import type { ArchitectureDocument } from "../lib/architecture-draft";
import type { ArchitectureSignal } from "../lib/architecture/signals";

const revision = "13157624fb0d8b63e5072049c94824d4b6d2e609";
const sources = [
  { path: "package.json", content: "1: {\"dependencies\":{\"next\":\"1\"}}" },
  { path: "app/page.tsx", content: "1: export default function Page() {}" },
  { path: "app/api/products/route.ts", content: "1: export async function POST() {}" },
  { path: "lib/db.ts", content: "1: import mysql from \"mysql2\"" },
];

describe("legacy architecture shadow", () => {
  it("compares independent signals with legacy facts without certifying edge evidence", () => {
    const document = buildArchitectureDocument({ productName: "Example", productSlug: "example", owner: "owner", name: "repo", revision, sources });
    const shadow = createLegacyArchitectureShadow({ revision, scope: "source-slice", sources, document });
    expect(shadow.status).toBe("completed");
    expect(shadow.version).toBe(1);
    expect(shadow.scope).toBe("source-slice");
    expect(shadow.signalCount).toBe(4);
    expect(shadow.factCounts).toEqual({ nodes: 4, edges: 3, roots: 1 });
    expect(shadow.coverage?.metrics.entrypoint).toEqual({ total: 2, covered: 2, missingSignalIds: [] });
    expect(shadow.coverage?.metrics.store).toEqual({ total: 1, covered: 1, missingSignalIds: [] });
    expect(shadow.coverage?.metrics.deployable.total).toBe(1);
    expect(shadow.coverage?.unclassifiedCriticalSignals.map((signal) => signal.kind)).toEqual(["deployable"]);
    expect(shadow.coverage?.unsupportedEdges).toHaveLength(3);
    expect(shadow.coverage?.publishable).toBe(false);
  });

  it("retains independent signal diagnostics when no legacy document is available", () => {
    const shadow = createLegacyArchitectureShadow({ revision, scope: "source-slice", sources });
    expect(shadow.status).toBe("unavailable");
    expect(shadow.version).toBe(1);
    expect(shadow.signalCount).toBe(4);
    expect(shadow.factCounts).toBeNull();
    expect(shadow.coverage).toBeNull();
  });

  it("maps all legacy component and relationship categories without inventing event roots", () => {
    const component = (id: string, type: string, label = id, sources?: Array<{ path: string; line?: number }>) => ({ id, type, label, pos: [0, 0], size: [100, 60], sources });
    const connection = (id: string, from: string, to: string, label?: string) => ({ id, from, to, label });
    const document = {
      components: [
        component("users", "external"), component("frontend", "frontend"), component("agent", "backend", "Render Agent"),
        component("worker", "backend", "Worker"), component("api", "backend"), component("api-out", "backend"),
        component("db", "database", "db", [{ path: "db.ts" }]), component("cos", "cloud"), component("queue", "messagebus"),
        component("event", "external"), component("incoming", "external"), component("silent", "external"),
      ],
      connections: [
        connection("users-api", "users", "api"), connection("event-api", "event", "api", "webhook 推送"),
        connection("api-incoming", "api", "incoming", "HTTPS"), connection("incoming-api", "incoming", "api", "HTTPS"),
        connection("api-out-db", "api-out", "db", "MySQL"), connection("worker-db", "worker", "db", "轮询"),
        connection("agent-cos", "agent", "cos", "上传 PUT"), connection("api-queue", "api", "queue", "定时"),
        connection("queue-worker", "queue", "worker", "下载"), connection("api-frontend", "api", "frontend", "OAuth"),
      ],
    } as unknown as ArchitectureDocument;
    const signals: ArchitectureSignal[] = [{ id: "db-signal", kind: "store", critical: true, evidence: { path: "db.ts", line: 1, detector: "test" } }];
    const facts = legacyArchitectureFacts(revision, document, signals);
    expect(facts.version).toBe(1);
    expect(facts.roots).toEqual(["event", "users"]);
    expect(Object.fromEntries(facts.nodes.map((node) => [node.id, node.kind]))).toEqual(expect.objectContaining({
      users: "user", frontend: "frontend", agent: "agent", worker: "worker", api: "api", db: "database", cos: "object-store", queue: "queue", event: "external",
    }));
    expect(facts.nodes.find((node) => node.id === "db")).toEqual(expect.objectContaining({ signalIds: ["db-signal"], evidence: [] }));
    expect(facts.edges.map((edge) => edge.kind)).toEqual(expect.arrayContaining(["http", "callback", "sql", "poll", "upload", "schedule", "download", "oauth"]));
    expect(facts.edges.find((edge) => edge.id === "users-api")?.label).toBe("users-api");
  });
});
