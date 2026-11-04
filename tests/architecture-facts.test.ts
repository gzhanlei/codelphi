import { describe, expect, it } from "vitest";
import { architectureFactSetSchema, type ArchitectureFactSet, type EdgeFact, type NodeFact } from "../lib/architecture/facts";
import { collectArchitectureSignals, type ArchitectureSignalInventory } from "../lib/architecture/signals";
import { evaluateArchitectureCoverage } from "../lib/architecture/coverage";

const revision = "13157624fb0d8b63e5072049c94824d4b6d2e609";
const evidence = (path: string, line = 1) => ({ path, line, detector: "test-detector" });
const node = (id: string, kind: NodeFact["kind"], signalIds: string[] = []): NodeFact => ({ id, kind, label: id, signalIds, evidence: kind === "user" ? [] : [evidence(`${id}.ts`)] });
const edge = (id: string, from: string, to: string, signalIds: string[] = []): EdgeFact => ({ id, from, to, kind: "http", label: id, signalIds, evidence: [evidence(`${from}.ts`, 2)] });
const inventory = (signals: ArchitectureSignalInventory["signals"], scope: ArchitectureSignalInventory["scope"] = "repository"): ArchitectureSignalInventory => ({ version: 1, revision, scope, signals });
const signal = (id: string, kind: ArchitectureSignalInventory["signals"][number]["kind"], critical = true): ArchitectureSignalInventory["signals"][number] => ({ id, kind, critical, evidence: evidence(`${id}.ts`) });
const facts = (nodes: NodeFact[], edges: EdgeFact[], roots = ["users"]): ArchitectureFactSet => ({ version: 1, revision, roots, nodes, edges, omissions: [] });

describe("architecture signal inventory", () => {
  it("collects stable independent signals with actual numbered source lines", () => {
    const sources = [
      { path: "internal/store/mysql.go", content: "1: package store\n37: sql.Open(\"mysql\", dsn)" },
      { path: "cmd/worker/main.go", content: "1: package main\n2: func main() {}" },
      { path: "backend/internal/cos/cos.go", content: "1: package cos\n8: NewQCloudClient()" },
      { path: "app/page.tsx", content: "1: export default function Page() {}" },
      { path: "cmd/server/main.go", content: "1: package main\n2: func main() {}" },
    ];
    const first = collectArchitectureSignals({ revision, scope: "repository" }, sources);
    const second = collectArchitectureSignals({ revision, scope: "repository" }, [...sources].reverse());
    expect(first).toEqual(second);
    expect(first.version).toBe(1);
    expect(first.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "entrypoint", evidence: expect.objectContaining({ path: "app/page.tsx", line: 1 }) }),
      expect.objectContaining({ kind: "deployable", evidence: expect.objectContaining({ path: "cmd/server/main.go", line: 2 }) }),
      expect.objectContaining({ kind: "worker", evidence: expect.objectContaining({ path: "cmd/worker/main.go", line: 2 }) }),
      expect.objectContaining({ kind: "store", evidence: expect.objectContaining({ path: "internal/store/mysql.go", line: 37 }) }),
      expect.objectContaining({ kind: "external", evidence: expect.objectContaining({ path: "backend/internal/cos/cos.go", line: 8 }) }),
    ]));
    expect(new Set(first.signals.map((item) => item.id)).size).toBe(first.signals.length);
    const ignored = collectArchitectureSignals({ revision, scope: "repository" }, [
      { path: "README.md", content: "1: chat/completions" },
      { path: "components/analysis-status-refresh.tsx", content: "1: setInterval(refresh, 3000)" },
      { path: "internal/worker/runner_test.go", content: "1: NewQCloudClient()" },
      { path: "internal/config/config.go", content: "1: // ImgSecCheck is optional" },
      { path: "internal/production/service.go", content: "1: // requestVirtualPayment is called by the client" },
      { path: "internal/seedance/client.go", content: "1: type CreateTaskRequest struct{}" },
    ]);
    expect(ignored.signals).toEqual([]);
    const scheduled = collectArchitectureSignals({ revision, scope: "repository" }, [{ path: "worker.ts", content: "1: setInterval(run, 1000)" }]);
    expect(scheduled.signals.map((signal) => signal.kind)).toEqual(["worker"]);
    const unnumbered = collectArchitectureSignals({ revision, scope: "repository" }, [{ path: "internal/store/mysql.go", content: "package store\nsql.Open(\"mysql\", dsn)" }]);
    expect(unnumbered.signals.find((item) => item.kind === "store")?.evidence.line).toBe(2);
  });
});

describe("architecture coverage", () => {
  it("accepts a fully evidenced repository graph with multiple legitimate roots", () => {
    const signals = [signal("entry", "entrypoint"), signal("scheduled", "worker"), signal("mysql", "store")];
    const document = facts([
      node("users", "user"),
      node("scheduler", "external"),
      node("api", "api", ["entry"]),
      node("worker", "worker", ["scheduled"]),
      node("db", "database", ["mysql"]),
    ], [
      edge("users-api", "users", "api", ["entry"]),
      edge("scheduler-worker", "scheduler", "worker", ["scheduled"]),
      edge("api-db", "api", "db", ["mysql"]),
      edge("worker-db", "worker", "db", ["mysql"]),
    ], ["users", "scheduler"]);
    const report = evaluateArchitectureCoverage(inventory(signals), document);
    expect(report.publishable).toBe(true);
    expect(report.unreachableRuntimeUnits).toEqual([]);
    expect(report.metrics.worker).toEqual({ total: 1, covered: 1, missingSignalIds: [] });
  });

  it("accepts the smallest fully evidenced single-entry graph", () => {
    const report = evaluateArchitectureCoverage(inventory([]), facts([node("users", "user"), node("api", "api")], [edge("users-api", "users", "api")]));
    expect(report.publishable).toBe(true);
    expect(report.unreachableRuntimeUnits).toEqual([]);
  });

  it("fails closed for missing critical signals and unsupported relationships", () => {
    const signals = [signal("entry", "entrypoint"), signal("mysql", "store")];
    const document = facts([node("users", "user"), node("api", "api", ["entry"])], [{ ...edge("users-api", "users", "api", ["entry"]), evidence: [] }]);
    const report = evaluateArchitectureCoverage(inventory(signals), document);
    expect(report.publishable).toBe(false);
    expect(report.unclassifiedCriticalSignals.map((item) => item.id)).toEqual(["mysql"]);
    expect(report.unsupportedEdges).toEqual(["users-api"]);
    expect(report.metrics.store).toEqual({ total: 1, covered: 0, missingSignalIds: ["mysql"] });
  });

  it("reports unreachable runtime units instead of using undirected connectivity", () => {
    const document = facts([
      node("users", "user"),
      node("api", "api"),
      node("worker", "worker"),
    ], [
      edge("users-api", "users", "api"),
      edge("worker-api", "worker", "api"),
    ]);
    const report = evaluateArchitectureCoverage(inventory([]), document);
    expect(report.unreachableRuntimeUnits).toEqual(["worker"]);
    expect(report.publishable).toBe(false);
  });

  it("never marks a source-slice diagnostic as repository-publishable", () => {
    const document = facts([node("users", "user"), node("api", "api")], [edge("users-api", "users", "api")]);
    const report = evaluateArchitectureCoverage(inventory([], "source-slice"), document);
    expect(report.publishable).toBe(false);
    expect(report.unclassifiedCriticalSignals).toEqual([]);
    expect(report.unreachableRuntimeUnits).toEqual([]);
  });

  it("requires roots, multiple nodes and at least one relationship for publication", () => {
    const users = node("users", "user");
    expect(evaluateArchitectureCoverage(inventory([]), facts([node("event-a", "external"), node("event-b", "external")], [edge("event", "event-a", "event-b")], [])).publishable).toBe(false);
    expect(evaluateArchitectureCoverage(inventory([]), facts([users], [{ ...edge("self", "users", "users"), evidence: [evidence("users.ts")] }])).publishable).toBe(false);
    expect(evaluateArchitectureCoverage(inventory([]), facts([users, node("event", "external")], [])).publishable).toBe(false);
  });

  it("rejects dangling references and unknown signal coverage", () => {
    expect(() => architectureFactSetSchema.parse(facts([node("users", "user")], [edge("bad", "users", "missing")]))).toThrow();
    expect(() => evaluateArchitectureCoverage(inventory([]), facts([node("users", "user"), node("api", "api", ["unknown"])], [edge("users-api", "users", "api")]))).toThrow("Unknown architecture signal: unknown");
  });
});
