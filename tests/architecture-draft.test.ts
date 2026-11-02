import { describe, expect, it } from "vitest";
import { buildArchitectureDocument } from "../lib/architecture-draft";

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

  it("rejects unrelated repositories and stale source content", () => {
    const unrelated = { productName: "Other", productSlug: "other", owner: "example", name: "other", revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea", sources: sources() };
    expect(() => buildArchitectureDocument(unrelated)).toThrow("only available for gzhanlei/radar");
    expect(() => buildArchitectureDocument({ ...unrelated, owner: "gzhanlei" })).toThrow("only available for gzhanlei/radar");
    expect(() => buildArchitectureDocument({ ...unrelated, name: "radar" })).toThrow("only available for gzhanlei/radar");
    const stale = { productName: "Radar", productSlug: "radar", owner: "gzhanlei", name: "radar", revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea", sources: sources().map((source) => ({ ...source, content: "1: unrelated" })) };
    expect(() => buildArchitectureDocument(stale)).toThrow("No architecture components detected");
  });

  it("rejects unsupported repositories and invalid revisions", () => {
    const input = { productName: "Empty", productSlug: "empty", owner: "gzhanlei", name: "radar", revision: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea", sources: [] };
    expect(() => buildArchitectureDocument(input)).toThrow("No architecture components detected");
    expect(() => buildArchitectureDocument({ ...input, revision: "short", sources: sources() })).toThrow();
  });
});
