import { describe, expect, it } from "vitest";
import { extractArchitectureFacts } from "../lib/architecture/extract";
import { evaluateArchitectureCoverage } from "../lib/architecture/coverage";
import { collectArchitectureSignals } from "../lib/architecture/signals";
import { projectArchitectureDocument, architectureProjectionId } from "../lib/architecture/project";
import { goHttpInternals } from "../lib/architecture/detectors/go-http";
import { architectureCallContext } from "../lib/architecture/source";

const revision = "13157624fb0d8b63e5072049c94824d4b6d2e609";

function extract(sources: Array<{ path: string; content: string }>) {
  return extractArchitectureFacts({ revision, scope: "repository" }, sources);
}

function edge(facts: ReturnType<typeof extract>, from: string, to: string) {
  return facts.edges.find((candidate) => candidate.from === from && candidate.to === to);
}

describe("direct architecture fact extraction", () => {
  it("derives Go API and Worker database flows without inventing a direct API-to-Worker call", () => {
    const facts = extract([
      { path: "go.mod", content: "1: module example.com/app\n" },
      { path: "cmd/server/main.go", content: "1: package main\n2: import (\n3: \"example.com/app/internal/store\"\n4: )\n5: func main() {\n6: db := store.Open()\n7: http.ListenAndServe(\":8080\", nil)\n8: }" },
      { path: "cmd/worker/main.go", content: "1: package main\n2: import (\n3: \"example.com/app/internal/store\"\n4: \"example.com/app/internal/worker\"\n5: )\n6: func main() {\n7: db := store.Open()\n8: worker.NewRunner(db)\n9: }" },
      { path: "internal/store/mysql.go", content: "1: package store\n2: func Open() {\n3: sql.Open(\"mysql\", dsn)\n4: }" },
      { path: "internal/worker/runner.go", content: "1: package worker\n2: func NewRunner(db Store) {\n3: time.NewTicker(time.Second)\n4: }" },
    ]);
    expect(facts.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["actor:users", "actor:scheduler", "go:cmd/server", "go:cmd/worker", "store:mysql"]));
    expect(edge(facts, "go:cmd/server", "store:mysql")?.kind).toBe("sql");
    expect(edge(facts, "go:cmd/worker", "store:mysql")?.kind).toBe("poll");
    expect(edge(facts, "go:cmd/worker", "store:mysql")?.label).toBe("轮询 / 更新任务");
    expect(edge(facts, "go:cmd/server", "go:cmd/worker")).toBeUndefined();
    expect(edge(facts, "actor:scheduler", "go:cmd/worker")?.kind).toBe("schedule");
    expect(facts.nodes.find((node) => node.id === "go:cmd/server")?.sourcePaths).toContain("internal/store/mysql.go");
    expect(facts.nodes.find((node) => node.id === "actor:users")).toEqual(expect.objectContaining({ kind: "user", synthetic: true }));
    expect(facts.nodes.find((node) => node.id === "actor:scheduler")).toEqual(expect.objectContaining({ kind: "external", synthetic: true }));
  });

  it("uses the same inventory as extraction for a publishable Go graph", () => {
    const sources = [
      { path: "cmd/server/main.go", content: "1: func main() {\n2: store.Open()\n3: http.ListenAndServe(\":8080\", nil)\n4: }" },
      { path: "cmd/worker/main.go", content: "1: func main() {\n2: store.Open()\n3: worker.NewRunner()\n4: }" },
      { path: "internal/store/mysql.go", content: "1: sql.Open(\"mysql\", dsn)" },
      { path: "internal/store/identity.go", content: "1: import \"database/sql\"" },
    ];
    const facts = extract(sources);
    const coverage = evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts);
    expect(coverage.unclassifiedCriticalSignals).toEqual([]);
    expect(coverage.unsupportedEdges).toEqual([]);
    expect(coverage.unreachableRuntimeUnits).toEqual([]);
    expect(coverage.publishable).toBe(true);
  });

  it("derives independent Next.js UI and API entrypoints without assuming UI-to-API calls", () => {
    const sources = [
      { path: "package.json", content: "1: {\"dependencies\":{\"next\":\"1\"}}" },
      { path: "app/page.tsx", content: "1: export default function Page() {}" },
      { path: "app/api/products/route.ts", content: "1: export async function POST() {}" },
    ];
    const facts = extract(sources);
    expect(edge(facts, "actor:users", "next:root:ui")).toBeDefined();
    expect(edge(facts, "actor:users", "next:root:api")).toBeDefined();
    expect(edge(facts, "next:root:ui", "next:root:api")).toBeUndefined();
    expect(evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts).publishable).toBe(true);
  });

  it("derives PHP request, SQL and file-cache flows", () => {
    const sources = [
      { path: "index.php", content: "1: <!DOCTYPE html>\n2: <form method=\"POST\">\n3: require_once \"cache_manager.php\";\n4: new CacheManager();\n5: new PDO($dsn);" },
      { path: "cache_manager.php", content: "1: class CacheManager {\n2: file_get_contents($path);\n3: file_put_contents($path, $value);\n4: }" },
    ];
    const facts = extract(sources);
    expect(edge(facts, "actor:users", "php:root:ui")).toBeDefined();
    expect(edge(facts, "php:root:ui", "php:root:app")).toBeDefined();
    expect(edge(facts, "php:root:app", "store:mysql")).toBeDefined();
    expect(edge(facts, "php:root:app", "store:file-cache")).toBeDefined();
    expect(evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts).publishable).toBe(true);
  });

  it("resolves Go import closures, external SDKs and registered internal HTTP routes", () => {
    const facts = extract([
      { path: "go.mod", content: "module example.com/app\n" },
      { path: "cmd/server/main.go", content: "1: import \"example.com/app/internal/api\"\n2: func main() {\n3: api.NewHandler()\n4: http.ListenAndServe()\n5: }" },
      { path: "cmd/worker/main.go", content: "1: import (\"example.com/app/internal/aiphoto\"; \"example.com/app/internal/cos\"; \"example.com/app/internal/xpay\"; \"example.com/app/internal/wechatmp\"; \"example.com/app/internal/worker\")\n2: func main() {\n3: worker.NewRunner()\n4: }" },
      { path: "cmd/remoteagent/main.go", content: "1: import (\n2: \"example.com/app/internal/cos\"\n3: \"example.com/app/internal/catalog\"\n4: )\n5: func main() {\n6: for {\n7: doJSON(\"/api/worker/render-tasks/claim\")\n8: doJSON(\"/api/worker/render-tasks/complete\")\n9: doJSON(\"/api/worker/render-tasks/fail\")\n10: doJSON(\"/api/worker/health\")\n11: }\n12: }" },
      { path: "internal/api/worker_api.go", content: "1: r.Route(\"/api/worker\", func(r chi.Router) {\n2: r.Post(\"/render-tasks/claim\", handler)\n3: r.Post(\"/render-tasks/complete\", handler)\n4: r.Post(\"/render-tasks/fail\", handler)\n5: })\n6: r.Post(\"/health\", handler)" },
      { path: "internal/api/agent_wake.go", content: "1: wakeRenderAgent(AgentWakeURL)" },
      { path: "internal/api/xpay_api.go", content: "1: xpay_goods_deliver_notify" },
      { path: "internal/aiphoto/client.go", content: "1: POST /api/partner/v1/generate" },
      { path: "internal/cos/cos.go", content: "1: NewQCloudClient()\n2: PutObject()\n3: PresignGet()" },
      { path: "internal/catalog/catalog.go", content: "1: // xpay.ProductIDFor is part of the historical contract" },
      { path: "internal/xpay/xpay.go", content: "1: BuildPayment()" },
      { path: "internal/wechatmp/client.go", content: "1: Code2Session()" },
      { path: "internal/worker/runner.go", content: "1: // remote agents call /api/worker/render-tasks/claim\n2: # /api/worker/render-tasks/claim\n3: * /api/worker/render-tasks/claim\n4: // http.Get(\"/api/worker/render-tasks/claim\")" },
    ]);
    expect(edge(facts, "go:cmd/worker", "external:aiphoto")).toBeDefined();
    expect(facts.edges.some((candidate) => candidate.from === "go:cmd/worker" && candidate.to === "store:cos" && candidate.kind === "upload")).toBe(true);
    expect(facts.edges.some((candidate) => candidate.from === "go:cmd/worker" && candidate.to === "store:cos" && candidate.kind === "download")).toBe(true);
    expect(edge(facts, "go:cmd/worker", "external:xpay")).toBeDefined();
    expect(edge(facts, "go:cmd/worker", "external:wechat")).toBeDefined();
    expect(edge(facts, "go:cmd/remoteagent", "go:cmd/server")?.label).toBe("/api/worker/render-tasks/claim");
    expect(facts.edges.filter((candidate) => candidate.from === "go:cmd/remoteagent" && candidate.to === "go:cmd/server").map((candidate) => candidate.label)).toEqual(expect.arrayContaining(["/api/worker/render-tasks/claim", "/api/worker/render-tasks/complete", "/api/worker/render-tasks/fail"]));
    expect(facts.edges.some((candidate) => candidate.label === "/api/worker/health")).toBe(false);
    expect(edge(facts, "go:cmd/server", "go:cmd/remoteagent")?.label).toBe("Agent 唤醒");
    expect(edge(facts, "external:xpay", "go:cmd/server")?.kind).toBe("callback");
    expect(edge(facts, "go:cmd/worker", "go:cmd/server")).toBeUndefined();
    expect(edge(facts, "go:cmd/remoteagent", "external:xpay")).toBeUndefined();
    for (const node of facts.nodes.filter((node) => node.id.startsWith("go:"))) {
      expect(node.signalIds.every((id) => !id.startsWith("store:") && !id.startsWith("external:"))).toBe(true);
    }
    expect(facts.edges.filter((candidate) => candidate.kind === "callback")).toHaveLength(1);
  });

  it("matches dynamic Go routes and reports unregistered internal calls", () => {
    const sources = [
      { path: "go.mod", content: "1: module example.com/app\n" },
      { path: "cmd/server/main.go", content: "1: import \"example.com/app/internal/api\"\n2: func main() {\n3: http.ListenAndServe()\n4: }" },
      { path: "cmd/remoteagent/main.go", content: "1: func main() {\n2: for {\n3: doJSON(\"/api/worker/render-tasks/claim\")\n4: doJSON(\n5: \"/api/worker/render-tasks/\"+id+\"/complete\")\n6: doJSON(\n7: \"/api/worker/render-tasks/\"+id+\"/fail\")\n8: doJSON(\"/api/worker/health\")\n9: }\n10: }" },
      { path: "internal/api/worker.go", content: "1: r.Route(\"/api/worker\", func(r chi.Router) {\n2: r.Post(\"/render-tasks/claim\", handler)\n3: r.Post(\"/render-tasks/{id}/complete\", handler)\n4: r.Post(\"/render-tasks/{id}/fail\", handler)\n5: })" },
    ];
    const facts = extract(sources);
    const labels = facts.edges.filter((candidate) => candidate.from === "go:cmd/remoteagent" && candidate.to === "go:cmd/server").map((candidate) => candidate.label);
    expect(labels).toEqual(expect.arrayContaining(["/api/worker/render-tasks/claim", "/api/worker/render-tasks/{id}/complete", "/api/worker/render-tasks/{id}/fail"]));
    expect(labels).not.toContain("/api/worker/health");
    const coverage = evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts);
    expect(coverage.metrics.relationship.total).toBe(4);
    expect(coverage.metrics.relationship.covered).toBe(3);
    expect(coverage.unclassifiedCriticalSignals.map((signal) => signal.id)).toEqual(["relationship:cmd/remoteagent/main.go:8:go-internal-http-call"]);
    expect(coverage.publishable).toBe(false);
  });

  it("scans dynamic route fragments in order and retains multiline call context", () => {
    expect(goHttpInternals.routeFragments("/api/worker/{id}/complete")).toEqual(["/api/worker/", "/complete"]);
    expect(goHttpInternals.routeFragments("{id}/complete")).toEqual(["", "/complete"]);
    expect(goHttpInternals.containsRouteFragments("abxba", ["a", "b", "a"])).toBe(true);
    expect(goHttpInternals.containsRouteFragments("a", ["a"])).toBe(true);
    expect(goHttpInternals.containsRouteFragments("ba", ["a", "b"])).toBe(false);
    expect(architectureCallContext(["http.NewRequest(", "\"/api/worker\""], 1)).toBe("http.NewRequest(\n\"/api/worker\"");
    expect(architectureCallContext(["http.NewRequest("], 0)).toBe("\nhttp.NewRequest(");
  });

  it("does not treat a COS constructor as an upload without a directional operation", () => {
    const facts = extract([
      { path: "go.mod", content: "1: module example.com/app\n" },
      { path: "cmd/worker/main.go", content: "1: import \"example.com/app/internal/cos\"\n2: func main() {}" },
      { path: "internal/cos/cos.go", content: "1: NewQCloudClient()" },
    ]);
    expect(facts.nodes.some((node) => node.id === "store:cos")).toBe(true);
    expect(edge(facts, "go:cmd/worker", "store:cos")).toBeUndefined();
  });

  it("connects mini-program cloud, storage and payment calls with caller evidence", () => {
    const sources = [
      { path: "miniprogram/app.json", content: "1: {\"pages\":[\"pages/index/index\"]}" },
      { path: "miniprogram/utils/cloud.js", content: "1: wx.cloud.callContainer()" },
      { path: "miniprogram/utils/upload.js", content: "1: presign()\n2: PUT upload_url" },
      { path: "miniprogram/utils/virtualPay.js", content: "1: requestVirtualPayment()" },
      { path: "cmd/server/main.go", content: "1: func main() {\n2: http.ListenAndServe()\n3: }" },
      { path: "backend/internal/cos/cos.go", content: "1: NewQCloudClient()" },
      { path: "backend/internal/xpay/xpay.go", content: "1: BuildPayment()" },
    ];
    const facts = extract(sources);
    expect(edge(facts, "actor:users", "miniprogram:miniprogram")).toBeDefined();
    expect(edge(facts, "miniprogram:miniprogram", "go:cmd/server")?.label).toBe("云托管 API");
    expect(edge(facts, "miniprogram:miniprogram", "store:cos")?.kind).toBe("upload");
    expect(edge(facts, "miniprogram:miniprogram", "external:xpay")).toBeDefined();
    expect(edge(facts, "external:xpay", "go:cmd/server")).toBeUndefined();
    const coverage = evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts);
    expect(coverage.metrics.relationship).toEqual({ total: 1, covered: 1, missingSignalIds: [] });
    expect(coverage.publishable).toBe(true);
  });

  it("resolves Next.js import closures, after workers, OAuth and webhook callbacks", () => {
    const sources = [
      { path: "package.json", content: "1: {\"dependencies\":{\"next\":\"1\"}}" },
      { path: "app/api/products/analyze/route.ts", content: "1: import { run } from \"@/lib/analysis\";\n2: export async function POST() {\n3: after(run)\n4: }" },
      { path: "app/api/webhooks/github/route.ts", content: "1: import \"@/lib/github-source\";\n2: export async function POST() {\n3: webhook(push)\n4: }" },
      { path: "app/auth/callback/route.ts", content: "1: import \"@/lib/chandler\";\n2: export async function GET() {\n3: oauth()\n4: }" },
      { path: "lib/analysis.ts", content: "1: import \"@/lib/github-source\";\n2: import \"@/lib/archify-cli\";\n3: import \"@/lib/db\";\n4: fetch(\"https://ai.example/chat/completions\")" },
      { path: "lib/db.ts", content: "1: import mysql from \"mysql2\"" },
      { path: "lib/github-source.ts", content: "1: fetch(\"https://api.github.com/repos\")" },
      { path: "lib/archify-cli.ts", content: "1: deliverArchify()" },
      { path: "lib/chandler.ts", content: "1: fetch(\"/v1/oauth/token\")" },
    ];
    const facts = extract(sources);
    expect(edge(facts, "next:root:api", "next:root:async")?.kind).toBe("schedule");
    expect(edge(facts, "next:root:async", "store:mysql")).toBeDefined();
    expect(edge(facts, "next:root:async", "external:github")).toBeDefined();
    expect(edge(facts, "next:root:async", "external:llm")).toBeDefined();
    expect(edge(facts, "next:root:async", "external:archify")?.kind).toBe("process");
    expect(edge(facts, "next:root:api", "external:llm")).toBeUndefined();
    expect(edge(facts, "next:root:api", "store:mysql")).toBeUndefined();
    expect(edge(facts, "next:root:api", "external:chandler")?.kind).toBe("oauth");
    expect(edge(facts, "external:github", "next:root:api")?.kind).toBe("callback");
    expect(facts.roots).toEqual(expect.arrayContaining(["actor:users", "external:github"]));
    expect(facts.nodes.find((node) => node.id === "next:root:async")?.signalIds.every((id) => id.startsWith("worker:"))).toBe(true);
    const coverage = evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts);
    expect(coverage.metrics.worker).toEqual({ total: 1, covered: 1, missingSignalIds: [] });
    expect(coverage.publishable).toBe(true);
  });

  it("ignores static detector declaration tables as runtime evidence", () => {
    const sources = [
      { path: "app/api/example/route.ts", content: "1: import \"@/lib/architecture-generic\";\n2: export async function POST() {}" },
      { path: "lib/architecture-generic.ts", content: "1: llm: { markers: [\"chat/completions\", \"mysql2\", \"deliverArchify\", \"chandlerOAuthClient\", \"api.github.com\", \"seedance.CreateTask\"] }" },
    ];
    const facts = extract(sources);
    expect(facts.nodes.map((node) => node.id)).toEqual(["actor:users", "next:root:api"]);
    expect(facts.edges.map((edge) => edge.id)).toEqual(["entry:users->next:root:api"]);
    expect(evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts).publishable).toBe(true);
  });

  it("recognizes pages-router and monorepo Next.js roots", () => {
    const pages = extract([{ path: "pages/index.tsx", content: "1: createRoot()" }]);
    expect(pages.nodes.some((node) => node.id === "next:root:ui")).toBe(true);
    const monorepo = extract([
      { path: "apps/web/package.json", content: "1: {\"dependencies\":{\"next\":\"1\"}}" },
      { path: "apps/web/app/page.tsx", content: "1: export default function Page() {}" },
    ]);
    expect(monorepo.nodes.some((node) => node.id === "next:apps/web:ui")).toBe(true);
    expect(monorepo.nodes.find((node) => node.id === "next:apps/web:ui")).toEqual(expect.objectContaining({ label: "apps/web Web UI", runtimeUnit: "apps/web" }));
    const singleCharacterRoot = extract([
      { path: "a/package.json", content: "1: {\"dependencies\":{\"next\":\"1\"}}" },
      { path: "a/app/page.tsx", content: "1: export default function Page() {}" },
    ]);
    expect(singleCharacterRoot.nodes.some((node) => node.id === "next:a:ui")).toBe(true);
    const rootLabels = extract([{ path: "app/page.tsx", content: "1: export default function Page() {}" }]);
    expect(rootLabels.nodes.find((node) => node.id === "next:root:ui")).toEqual(expect.objectContaining({ label: "Next.js Web UI", runtimeUnit: "next-root" }));
  });

  it("resolves Next.js aliases from the containing monorepo package", () => {
    const sources = [
      { path: "package.json", content: "1: {}" },
      { path: "apps/package.json", content: "1: {}" },
      { path: "apps/web/package.json", content: "1: {\"dependencies\":{\"next\":\"1\"}}" },
      { path: "apps/web/app/api/products/route.ts", content: "1: import { query } from \"@/lib/db\";\n2: export async function POST() {\n3: query()\n4: }" },
      { path: "apps/web/lib/db.ts", content: "1: import mysql from \"mysql2\"" },
    ];
    const facts = extract(sources);
    expect(edge(facts, "next:apps/web:api", "store:mysql")).toBeDefined();
    expect(evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, sources), facts).publishable).toBe(true);
    const withoutManifest = extract(sources.slice(3));
    expect(edge(withoutManifest, "next:apps/web:api", "store:mysql")).toBeDefined();
  });

  it("derives PHP application-only entrypoints and ignores unrelated PHP files", () => {
    const facts = extract([
      { path: "public/index.php", content: "1: $_SERVER[\"REQUEST_METHOD\"];" },
      { path: "lib/unrelated.php", content: "1: <?php echo \"Hello\";" },
    ]);
    expect(edge(facts, "actor:users", "php:public:app")).toBeDefined();
    expect(facts.nodes.some((node) => node.id === "php:lib:ui")).toBe(false);
    expect(facts.nodes.some((node) => node.id === "php:lib:app")).toBe(false);
    expect(extract([{ path: "lib/unrelated.php", content: "1: <?php echo \"Hello\";" }]).nodes).toEqual([]);
  });

  it("resolves imports from a root-level Go main", () => {
    const facts = extract([
      { path: "go.mod", content: "module example.com/app\n" },
      { path: "main.go", content: "1: import \"example.com/app/store\"\n2: func main() {\n3: store.Open()\n4: }" },
      { path: "store/mysql.go", content: "1: sql.Open(\"mysql\", dsn)" },
    ]);
    expect(edge(facts, "go:main", "store:mysql")).toBeDefined();
    expect(facts.nodes.find((node) => node.id === "go:main")?.sourcePaths).toContain("store/mysql.go");
  });

  it("distinguishes CLI, server and worker roots without inventing user-to-worker calls", () => {
    const cli = extract([{ path: "main.go", content: "1: func main() {}" }]);
    expect(cli.nodes.map((node) => node.id)).toEqual(["actor:cli-users", "go:main"]);
    expect(cli.nodes.find((node) => node.id === "go:main")?.kind).toBe("cli");
    expect(cli.roots).toEqual(["actor:cli-users"]);
    expect(edge(cli, "actor:cli-users", "go:main")?.kind).toBe("process");
    const worker = extract([{ path: "cmd/worker/main.go", content: "1: func main() {\n2: http.ListenAndServe()\n3: worker.NewRunner()\n4: }" }]);
    expect(edge(worker, "actor:users", "go:cmd/worker")).toBeUndefined();
    expect(edge(worker, "actor:scheduler", "go:cmd/worker")).toBeDefined();
    const api = extract([{ path: "cmd/server/main.go", content: "1: func main() {\n2: http.ListenAndServe()\n3: worker.NewRunner()\n4: }" }]);
    expect(edge(api, "actor:scheduler", "go:cmd/server")).toBeUndefined();
    const ignored = extract([{ path: "cmd/ignored/main.go", content: "1: http.ListenAndServe()" }]);
    expect(ignored.nodes.some((node) => node.id === "go:cmd/ignored")).toBe(false);
  });

  it("handles root mini-programs and refuses to guess among multiple Go APIs", () => {
    const root = extract([
      { path: "app.json", content: "1: {\"pages\":[]}" },
      { path: "cloud.js", content: "1: wx.cloud.callContainer()" },
      { path: "cmd/server/main.go", content: "1: func main() {\n2: http.ListenAndServe()\n3: }" },
    ]);
    expect(root.nodes.some((node) => node.id === "miniprogram:miniprogram")).toBe(true);
    expect(edge(root, "miniprogram:miniprogram", "go:cmd/server")).toBeDefined();
    const ambiguousSources = [
      { path: "app.json", content: "1: {\"pages\":[]}" },
      { path: "cloud.js", content: "1: wx.cloud.callContainer()" },
      { path: "cmd/server-a/main.go", content: "1: func main() {\n2: http.ListenAndServe()\n3: }" },
      { path: "cmd/server-b/main.go", content: "1: func main() {\n2: http.ListenAndServe()\n3: }" },
    ];
    const multiple = extract(ambiguousSources);
    expect(multiple.edges.filter((candidate) => candidate.from === "miniprogram:miniprogram" && candidate.kind === "http")).toEqual([]);
    const ambiguousCoverage = evaluateArchitectureCoverage(collectArchitectureSignals({ revision, scope: "repository" }, ambiguousSources), multiple);
    expect(ambiguousCoverage.publishable).toBe(false);
    expect(ambiguousCoverage.unclassifiedCriticalSignals.map((signal) => signal.kind)).toContain("relationship");
    const nonGo = extract([
      { path: "app.json", content: "1: {\"pages\":[]}" },
      { path: "cloud.js", content: "1: wx.cloud.callContainer()" },
      { path: "app/api/route.ts", content: "1: export async function POST() {}" },
    ]);
    expect(edge(nonGo, "miniprogram:miniprogram", "next:root:api")).toBeUndefined();
    const noCloud = extract([
      { path: "app.json", content: "1: {\"pages\":[]}" },
      { path: "cmd/server/main.go", content: "1: func main() {\n2: http.ListenAndServe()\n3: }" },
    ]);
    expect(edge(noCloud, "miniprogram:miniprogram", "go:cmd/server")).toBeUndefined();
  });

  it("resolves relative TypeScript index imports and tolerates unresolved or circular imports", () => {
    const facts = extract([
      { path: "app/api/route.ts", content: "1: import \"../../lib/services\";\n2: import \"react\";\n3: import \"../missing\";\n4: export async function POST() {}" },
      { path: "lib/services/index.ts", content: "1: import \"./cycle\";\n2: fetch(\"https://ai.example/chat/completions\")\n3: import mysql from \"mysql2\"" },
      { path: "lib/services/cycle.ts", content: "1: import \"./index\";" },
    ]);
    expect(edge(facts, "next:root:api", "external:llm")).toBeDefined();
    expect(edge(facts, "next:root:api", "store:mysql")).toBeDefined();
    expect(facts.nodes.find((node) => node.id === "next:root:api")?.sourcePaths).toEqual(expect.arrayContaining(["lib/services/index.ts", "lib/services/cycle.ts"]));
    expect(facts.nodes.find((node) => node.id === "next:root:api")?.sourcePaths).not.toContain(undefined);
    expect(facts.nodes.find((node) => node.id === "next:root:api")?.signalIds.every((id) => id.startsWith("entrypoint:") || id.startsWith("deployable:"))).toBe(true);
  });

  it("does not create storage self-links or unproven runtime relationships", () => {
    const frontend = extract([
      { path: "app/page.tsx", content: "1: import mysql from \"mysql2\";\n2: export default function Page() {}" },
    ]);
    expect(edge(frontend, "next:root:ui", "store:mysql")).toBeUndefined();
    expect(frontend.edges.every((candidate) => candidate.from !== candidate.to)).toBe(true);
    const worker = extract([
      { path: "cmd/worker/main.go", content: "1: func main() {\n2: worker.NewRunner()\n3: }" },
      { path: "internal/store/mysql.go", content: "1: sql.Open(\"mysql\", dsn)" },
    ]);
    expect(edge(worker, "go:cmd/worker", "store:mysql")).toBeUndefined();
    expect(worker.edges.every((candidate) => candidate.from !== candidate.to)).toBe(true);
    const fileCache = extract([
      { path: "index.php", content: "1: $_SERVER[\"REQUEST_METHOD\"];" },
      { path: "cache_manager.php", content: "1: file_get_contents($path);\n2: file_put_contents($path, $value);" },
    ]);
    expect(edge(fileCache, "php:root:app", "store:file-cache")).toBeUndefined();
  });

  it("does not route Go agent calls through a Next.js API", () => {
    const facts = extract([
      { path: "app/api/worker/route.ts", content: "1: r.Post(\"/api/worker/render-tasks/claim\")\n2: export async function POST() {}" },
      { path: "cmd/remoteagent/main.go", content: "1: func main() {\n2: for {\n3: doJSON(\"/api/worker/render-tasks/claim\")\n4: }\n5: }" },
    ]);
    expect(edge(facts, "go:cmd/remoteagent", "next:root:api")).toBeUndefined();
  });

  it("projects facts instead of selecting repository-specific Archify templates", () => {
    const sources = [
      { path: "package.json", content: "1: {\"dependencies\":{\"next\":\"1\"}}" },
      { path: "app/page.tsx", content: "1: export default function Page() {}" },
    ];
    const facts = extract(sources);
    const document = projectArchitectureDocument({ productName: "Any product", productSlug: "any-product", owner: "any-owner", name: "any-repo", revision }, facts);
    expect(document.components.map((component) => component.id)).toEqual([architectureProjectionId("actor:users"), architectureProjectionId("next:root:ui")]);
    expect(document.meta.repository?.revision).toBe(revision);
    expect(document.components[1].sources?.[0]).toEqual(expect.objectContaining({ path: "app/page.tsx", line: 1 }));
  });
});
