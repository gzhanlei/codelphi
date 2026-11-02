import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateArchitectureVersion, localRepositoryRoot } from "../lib/architecture-version";
import { ArchifyCommandError } from "../lib/archify-cli";

vi.mock("../lib/architecture-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/architecture-store")>();
  return { ...actual, getProductIdentity: vi.fn(async () => ({ id: 4, slug: "radar", name: "Radar" })) };
});

const run = { productId: 4, owner: "gzhanlei", name: "radar", afterSha: "43d8ce7b96f7e7deff9bb3b8429eb8ca361466ea" };
const product = { id: 4, slug: "radar", name: "Radar" };
const paths = [
  "app/products/[slug]/page.tsx", "components/product-navigation.tsx", "lib/chandler.ts", "app/auth/callback/route.ts",
  "app/api/products/route.ts", "lib/db.ts", "migrations/002_spec_versions.sql", "app/api/webhooks/github/route.ts",
  "lib/github-webhook.ts", "lib/analysis.ts", "lib/spec-versions.ts", "lib/github.ts", "lib/github-app.ts", "lib/ai.ts",
];
const sources = paths.map((path) => ({ path, content: `1: ${path} ProductView ProductTabs getProductDetails registerProduct POST mysql2 databaseConfig spec_versions CREATE TABLE WorkMembership OAuth chandler completeChandlerOAuth processGitHubWebhook verifyGitHubSignature push analyzeWithAI insertSpecVersion api.github.com resolveGitHubToken installation createAppJwt chatCompletionsUrl AI_API_KEY LLMGateway` }));

function fixture() {
  return { root: mkdtempSync(join(tmpdir(), "radar-architecture-version-")), save: vi.fn(async () => undefined), repoRoot: vi.fn(() => "/tmp/repo") };
}

describe("architecture version generation", () => {
  it("delivers and accepts an evidence-backed architecture version idempotently", async () => {
    const { root, save, repoRoot } = fixture();
    const deliver = vi.fn(async ({ output }: { output: string }) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(output, "<html>architecture</html>");
      return { ok: true, command: "deliver" };
    });
    const visualCheck = vi.fn(async () => ({ ok: true, command: "visual-check", containment: { status: "pass" } }));
    const input = { run, product, sources, specVersionId: 7 };
    const first = await generateArchitectureVersion(input, { root, save, deliver, visualCheck, repoRoot });
    expect(first).toMatchObject({ status: "accepted", productId: 4, specVersionId: 7, artifactPath: "artifacts/products/radar/7/architecture.html" });
    expect(first.specSha256).toHaveLength(64);
    expect(first.artifactSha256).toHaveLength(64);
    const second = await generateArchitectureVersion(input, { root, save, deliver, visualCheck, repoRoot });
    expect(second.specSha256).toBe(first.specSha256);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("marks delivery success with visual failure as rendered", async () => {
    const { root, save, repoRoot } = fixture();
    const deliver = vi.fn(async ({ output }: { output: string }) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(output, "<html>architecture</html>");
      return { ok: true, command: "deliver" };
    });
    const receipt = { ok: false, command: "visual-check", error: "Viewport overflow" };
    const visualCheck = vi.fn(async () => { throw new ArchifyCommandError(receipt); });
    const result = await generateArchitectureVersion({ run, product, sources, specVersionId: 7 }, { root, save, deliver, visualCheck, repoRoot });
    expect(result).toMatchObject({ status: "rendered", artifactSha256: expect.any(String), visualReceipt: receipt, errorMessage: "Viewport overflow" });
  });

  it("marks delivery failure as failed without an artifact hash", async () => {
    const { root, save, repoRoot } = fixture();
    const receipt = { ok: false, command: "deliver", error: "Invalid layout" };
    const deliver = vi.fn(async () => { throw new ArchifyCommandError(receipt); });
    const visualCheck = vi.fn(async () => ({ ok: true }));
    const result = await generateArchitectureVersion({ run, product, sources, specVersionId: 7 }, { root, save, deliver, visualCheck, repoRoot });
    expect(result).toMatchObject({ status: "failed", artifactPath: null, artifactSha256: null, validationReceipt: receipt, errorMessage: "Invalid layout" });
    expect(visualCheck).not.toHaveBeenCalled();
  });

  it("records a failure without calling Archify when no local checkout matches", async () => {
    const { root, save } = fixture();
    const deliver = vi.fn();
    const visualCheck = vi.fn();
    const result = await generateArchitectureVersion({ run, product, sources, specVersionId: 7 }, { root, save, deliver, visualCheck, repoRoot: () => undefined });
    expect(result).toMatchObject({ status: "failed", errorMessage: "No matching local checkout for gzhanlei/radar" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("persists prepare failures for unsupported content and spec write errors", async () => {
    const { root, save, repoRoot } = fixture();
    const unsupported = await generateArchitectureVersion({ run, product, sources: [], specVersionId: 7 }, { root, save, deliver: vi.fn(), visualCheck: vi.fn(), repoRoot });
    expect(unsupported).toMatchObject({ status: "failed", specJson: "", artifactPath: null, errorMessage: "No architecture components detected" });

    const blockedRoot = join(root, "blocked");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(blockedRoot, "not a directory");
    const writeFailure = await generateArchitectureVersion({ run, product, sources, specVersionId: 7 }, { root: blockedRoot, save, deliver: vi.fn(), visualCheck: vi.fn(), repoRoot });
    expect(writeFailure).toMatchObject({ status: "failed", artifactPath: null });
    expect(writeFailure.errorMessage).not.toBeNull();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("loads product identity when the product is omitted", async () => {
    const { root, save, repoRoot } = fixture();
    const deliver = vi.fn(async ({ output }: { output: string }) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(output, "html");
      return { ok: true };
    });
    const visualCheck = vi.fn(async () => ({ ok: true }));
    const result = await generateArchitectureVersion({ run, sources, specVersionId: 7 }, { root, save, deliver, visualCheck, repoRoot });
    expect(result).toMatchObject({ status: "accepted", productId: 4 });
  });

  it("uses the working directory when artifact root is omitted", async () => {
    const { save, repoRoot } = fixture();
    const deliver = vi.fn(async ({ output }: { output: string; input: string }) => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(output, "html");
      return { ok: true };
    });
    const visualCheck = vi.fn(async () => ({ ok: true }));
    await generateArchitectureVersion({ run, product, sources, specVersionId: 7 }, { save, deliver, visualCheck, repoRoot });
    expect(deliver.mock.calls[0][0].input).toBe(resolve(process.cwd(), "artifacts/products/radar/7/architecture.json"));
  });

  it("rejects an empty artifact root", async () => {
    const { save, repoRoot } = fixture();
    const result = await generateArchitectureVersion({ run, product, sources, specVersionId: 7 }, { root: "", save, deliver: vi.fn(), visualCheck: vi.fn(), repoRoot });
    expect(result).toMatchObject({ status: "failed", errorMessage: "Artifact root cannot be empty" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("resolves repository roots only from explicit mappings or the current repository", () => {
    expect(localRepositoryRoot(run, { RADAR_REPOSITORY_ROOTS: JSON.stringify({ "gzhanlei/radar": "/tmp/radar" }) })).toBe("/tmp/radar");
    expect(localRepositoryRoot(run, { GITHUB_REPOSITORY: "gzhanlei/radar" })).toBe(process.cwd());
    expect(localRepositoryRoot(run, {})).toBeUndefined();
    expect(localRepositoryRoot(run, { RADAR_REPOSITORY_ROOTS: "" })).toBeUndefined();
  });
});
