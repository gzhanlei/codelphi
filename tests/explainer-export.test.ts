import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportProductExplainer } from "../lib/explainer-export";
import { buildProductOverview } from "../lib/product-overview";

const release = { id: 8, title: "Specs", summary: "Summary", sha: "abcdef123456", url: "https://example.com/commit/abcdef1", committedAt: new Date("2026-11-01"), specVersionId: 8 };
const overview = buildProductOverview({
  product: { id: 1, slug: "radar", name: "Radar", description: "产品知识中心" },
  features: [{ id: 1, name: "登录", summary: "OAuth", parentId: null, source: "generated" }],
  scenarios: [{ id: 1, featureId: 1, reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy", source: "generated", evidence: [{ path: "app/auth.ts" }] }],
  releases: [release],
  behaviorChanges: [],
  latestRun: { status: "succeeded" },
});

describe("Explainer export", () => {
  it("writes a spec-only explainer without architecture artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-explainer-"));
    const finalize = vi.fn(async (_input: { input: string; output: string; browserCheck: boolean; outDir?: string }) => ({ ok: true, command: "finalize" }));
    const result = await exportProductExplainer({ productSlug: "radar", overview }, { root, finalize });
    expect(result).toMatchObject({ specPath: "artifacts/products/radar/8/explainer.md", artifactPath: "artifacts/products/radar/8/explainer.html" });
    const markdown = readFileSync(join(root, "artifacts/products/radar/8/explainer.md"), "utf8");
    expect(markdown).not.toContain("@diagram architecture");
    expect(markdown).not.toContain("{#architecture}");
    expect(existsSync(join(root, "artifacts/products/radar/8/architecture.json"))).toBe(false);
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ input: join(root, "artifacts/products/radar/8/explainer.md"), output: join(root, "artifacts/products/radar/8/explainer.html"), browserCheck: true }));
    expect(finalize.mock.calls[0][0]).not.toHaveProperty("repoRoot");
    const digest = createHash("sha256").update(markdown).digest("hex");
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ outDir: join(root, `artifacts/products/radar/8/receipts/${digest}`) }));
  });

  it("rejects a missing spec version", async () => {
    const root = mkdtempSync(join(tmpdir(), "radar-explainer-"));
    const finalize = vi.fn();
    await expect(exportProductExplainer({ productSlug: "radar", overview: { ...overview, trust: { ...overview.trust, specVersionId: null } } }, { root, finalize })).rejects.toThrow("Spec version is required");
    expect(finalize).not.toHaveBeenCalled();
  });
});
