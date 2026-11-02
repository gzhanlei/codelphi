import { describe, expect, it } from "vitest";
import { buildArchitectureDocument } from "../lib/architecture-generic";

const paths = [
  "app/products/[slug]/page.tsx",
  "components/product-navigation.tsx",
  "lib/chandler.ts",
  "app/auth/callback/route.ts",
  "app/api/products/route.ts",
  "lib/db.ts",
  "migrations/002_spec_versions.sql",
  "app/api/webhooks/github/route.ts",
  "lib/github-webhook.ts",
  "lib/analysis.ts",
  "lib/spec-versions.ts",
  "lib/github.ts",
  "lib/github-app.ts",
  "lib/ai.ts",
];

function sources(values = paths) {
  const markers = "ProductView ProductTabs getProductDetails registerProduct POST mysql2 databaseConfig spec_versions CREATE TABLE WorkMembership OAuth chandler completeChandlerOAuth processGitHubWebhook verifyGitHubSignature push analyzeWithAI insertSpecVersion api.github.com resolveGitHubToken installation createAppJwt chatCompletionsUrl AI_API_KEY LLMGateway";
  return values.map((path) => ({ path, content: `1: ${path} ${markers}` }));
}

describe("architecture draft", () => {
  it("builds a deterministic evidence-backed architecture document", () => {
    const input = {
      productName: "Radar",
      productSlug: "radar",
      owner: "gzhanlei",
      name: "radar",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources().reverse(),
    };
    const document = buildArchitectureDocument(input);
    expect(document.meta).toMatchObject({ title: "Radar 系统架构", output: "radar-architecture.html", quality_profile: "showcase" });
    expect(document.meta.repository).toMatchObject({ url: "https://github.com/gzhanlei/radar", revision: input.revision });
    expect(document.components.map((component) => component.id)).toEqual(["users", "radar-ui", "chandler", "next-api", "mysql", "webhook", "analysis", "github", "llm"]);
    expect(document.components.flatMap((component) => component.sources ?? []).every((source) => paths.includes(source.path))).toBe(true);
    expect(buildArchitectureDocument(input)).toEqual(document);
  });

  it("omits components and relationships whose evidence is absent", () => {
    const document = buildArchitectureDocument({
      productName: "Radar",
      productSlug: "radar",
      owner: "gzhanlei",
      name: "radar",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources(paths.filter((path) => path !== "lib/ai.ts")),
    });
    expect(document.components.some((component) => component.id === "llm")).toBe(false);
    expect(document.connections.some((connection) => connection.id === "analysis-to-llm")).toBe(false);
  });

  it("accepts a minimal user interface and frontend component", () => {
    const document = buildArchitectureDocument({
      productName: "Radar",
      productSlug: "radar",
      owner: "gzhanlei",
      name: "radar",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources(["components/product-navigation.tsx"]),
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "radar-ui"]);
  });

  it("builds a generic architecture for non-Radar repositories with matching source evidence", () => {
    const document = buildArchitectureDocument({
      productName: "Chandler",
      productSlug: "chandler",
      owner: "gzhanlei",
      name: "workmembership",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: [
        { path: "web/app/page.tsx", content: "1: export default function Home() {}" },
        { path: "internal/oauth/service.go", content: "1: package oauth\n2: // OAuth WorkMembership PKCE\n3: func Authorize() {}" },
        { path: "internal/db/db.go", content: "1: package db\n2: import _ \"github.com/go-sql-driver/mysql\"" },
      ],
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "frontend", "backend", "auth", "db"]);
    expect(document.meta.viewBox).toEqual([1200, 376]);
    expect(document.components.some((component) => component.id === "llm")).toBe(false);
    expect(document.components.flatMap((component) => component.sources ?? []).every((source) => source.line && source.line > 0)).toBe(true);
    expect(document.connections).toContainEqual(expect.objectContaining({ from: "backend", to: "db", label: "SQL" }));
    expect(document.connections.some((connection) => connection.id === "analysis-to-llm")).toBe(false);
    expect(document.connections.some((connection) => connection.id === "backend-to-analysis")).toBe(false);
  });

  it("sizes the desktop canvas for all detected components", () => {
    const document = buildArchitectureDocument({
      productName: "Chandler",
      productSlug: "chandler",
      owner: "gzhanlei",
      name: "workmembership",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: sources(),
    });
    expect(document.components.some((component) => component.id === "llm")).toBe(true);
    expect(document.meta.viewBox).toEqual([1200, 696]);
  });

  it("accepts a minimal generic frontend and caps component evidence", () => {
    const document = buildArchitectureDocument({
      productName: "Chandler",
      productSlug: "chandler",
      owner: "gzhanlei",
      name: "workmembership",
      revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea",
      sources: ["page", "a", "b", "c"].map((name) => ({ path: `web/app/${name}/page.tsx`, content: "1: export default function Page() {}" })),
    });
    expect(document.components.map((component) => component.id)).toEqual(["users", "frontend"]);
    expect(document.meta.viewBox).toEqual([960, 376]);
    expect(document.components[1].sources).toHaveLength(3);
  });

  it("rejects stale source content", () => {
    const stale = { productName: "Radar", productSlug: "radar", owner: "gzhanlei", name: "radar", revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea", sources: sources().map((source) => ({ ...source, content: "1: unrelated" })) };
    expect(() => buildArchitectureDocument(stale)).toThrow("No architecture components detected");
  });

  it("rejects unsupported repositories and invalid revisions", () => {
    const input = { productName: "Empty", productSlug: "empty", owner: "gzhanlei", name: "radar", revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea", sources: [] };
    expect(() => buildArchitectureDocument(input)).toThrow("No architecture components detected");
    expect(() => buildArchitectureDocument({ ...input, revision: "short", sources: sources() })).toThrow();
  });
});
