import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportProductExplainer } from "../lib/explainer-export";
import { buildProductOverview } from "../lib/product-overview";
import { buildArchitectureDocument } from "../lib/architecture-draft";

const release = { id: 8, title: "Specs", summary: "Summary", sha: "abcdef123456", url: "https://example.com/commit/abcdef1", committedAt: new Date("2026-11-01"), specVersionId: 8 };
const overview = buildProductOverview({
  product: { id: 1, slug: "radar", name: "Radar", description: "产品知识中心" },
  features: [{ id: 1, name: "登录", summary: "OAuth", parentId: null, source: "generated" }],
  scenarios: [{ id: 1, featureId: 1, reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", source: "generated", evidence: [{ path: "app/auth.ts" }] }],
  releases: [release],
  behaviorChanges: [],
  latestRun: { status: "succeeded" },
  architecture: { id: 5, specVersionId: 8, revision: "abcdef123456", status: "accepted", errorMessage: null },
});
const specDocument = buildArchitectureDocument({
  productName: "Radar",
  productSlug: "radar",
  owner: "gzhanlei",
  name: "radar",
  revision: "abcdef123456abcdef123456abcdef123456abcd",
  sources: [
    "app/products/[slug]/page.tsx", "components/product-navigation.tsx", "lib/chandler.ts", "app/auth/callback/route.ts",
    "app/api/products/route.ts", "lib/db.ts", "migrations/002_spec_versions.sql", "app/api/webhooks/github/route.ts",
    "lib/github-webhook.ts", "lib/analysis.ts", "lib/spec-versions.ts", "lib/github.ts", "lib/github-app.ts", "lib/ai.ts",
  ].map((path) => ({ path, content: `1: ${path} ProductView ProductTabs getProductDetails registerProduct POST mysql2 databaseConfig spec_versions CREATE TABLE WorkMembership OAuth chandler completeChandlerOAuth processGitHubWebhook verifyGitHubSignature push analyzeWithAI insertSpecVersion api.github.com resolveGitHubToken installation createAppJwt chatCompletionsUrl AI_API_KEY LLMGateway` })),
});
const architecture = {
  productId: 1,
  productSlug: "radar",
  productName: "Radar",
  specVersionId: 8,
  revision: "abcdef123456",
  status: "accepted" as const,
  specJson: JSON.stringify(specDocument),
  specSha256: "a".repeat(64),
  artifactPath: "artifacts/products/radar/8/architecture.html",
  artifactSha256: "b".repeat(64),
  validationReceipt: { ok: true },
  visualReceipt: { ok: true },
  errorMessage: null,
};

describe("Explainer export", () => {
  it("writes the draft and accepted spec before finalizing", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-explainer-"));
    const finalize = vi.fn(async () => ({ ok: true, command: "finalize" }));
    const result = await exportProductExplainer({ productSlug: "radar", overview, architecture, repoRoot: "/tmp/repo" }, { root, finalize });
    expect(result).toMatchObject({ specPath: "artifacts/products/radar/8/explainer.md", artifactPath: "artifacts/products/radar/8/explainer.html" });
    expect(readFileSync(join(root, "artifacts/products/radar/8/architecture.json"), "utf8")).toBe(architecture.specJson);
    expect(readFileSync(join(root, "artifacts/products/radar/8/explainer.md"), "utf8")).toContain("@diagram architecture source=architecture.json");
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ input: join(root, "artifacts/products/radar/8/explainer.md"), output: join(root, "artifacts/products/radar/8/explainer.html"), repoRoot: "/tmp/repo", browserCheck: true }));
    const markdown = readFileSync(join(root, "artifacts/products/radar/8/explainer.md"), "utf8");
    const digest = createHash("sha256").update(markdown).digest("hex");
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outDir: join(root, `artifacts/products/radar/8/receipts/${digest}`) }));
  });

  it("omits architecture evidence when it is not accepted", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-explainer-"));
    const finalize = vi.fn(async () => ({ ok: true, command: "finalize" }));
    await exportProductExplainer({ productSlug: "radar", overview: { ...overview, architecture: { ...overview.architecture!, status: "failed" } }, architecture: { ...architecture, status: "failed" } }, { root, finalize });
    expect(existsSync(join(root, "artifacts/products/radar/8/architecture.json"))).toBe(false);
    expect(readFileSync(join(root, "artifacts/products/radar/8/explainer.md"), "utf8")).not.toContain("@diagram architecture");
    expect(readFileSync(join(root, "artifacts/products/radar/8/explainer.md"), "utf8")).not.toContain("repo_url=");
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ repoRoot: undefined }));
  });

  it("exports without an architecture document", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-explainer-"));
    const finalize = vi.fn(async () => ({ ok: true, command: "finalize" }));
    await exportProductExplainer({ productSlug: "radar", overview, architecture: undefined }, { root, finalize });
    expect(existsSync(join(root, "artifacts/products/radar/8/architecture.json"))).toBe(false);
    expect(readFileSync(join(root, "artifacts/products/radar/8/explainer.md"), "utf8")).not.toContain("@diagram architecture");
  });

  it("does not include evidence when only the architecture record is accepted", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-explainer-"));
    const finalize = vi.fn(async () => ({ ok: true, command: "finalize" }));
    await exportProductExplainer({ productSlug: "radar", overview: { ...overview, architecture: undefined }, architecture }, { root, finalize });
    expect(existsSync(join(root, "artifacts/products/radar/8/architecture.json"))).toBe(false);
  });

  it("rejects missing spec versions and architecture version mismatches", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-explainer-"));
    const finalize = vi.fn();
    await expect(exportProductExplainer({ productSlug: "radar", overview: { ...overview, trust: { ...overview.trust, specVersionId: null } }, architecture }, { root, finalize })).rejects.toThrow("Spec version is required");
    await expect(exportProductExplainer({ productSlug: "radar", overview, architecture: { ...architecture, specVersionId: 9 } }, { root, finalize })).rejects.toThrow("Architecture version mismatch");
  });
});
