import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateRepositoryArchitectureVersion } from "../lib/architecture-version";

const run = { productId: 4, owner: "owner", name: "repo", afterSha: "13157624fb0d8b63e5072049c94824d4b6d2e609", provider: "github" as const };
const product = { id: 4, slug: "repo", name: "Repository" };
const nextSources = [
  { path: "app/page.tsx", content: "1: export default function Page() {}" },
  { path: "package.json", content: "1: {\"scripts\":{\"dev\":\"next dev\",\"start\":\"next start\"}}" },
];

function fixture(sources = nextSources) {
  const root = mkdtempSync(join(tmpdir(), "radar-repository-architecture-"));
  const save = vi.fn(async () => undefined);
  const deliver = vi.fn(async ({ output }: { output: string }) => {
    writeFileSync(output, "<html>architecture</html>");
    return { ok: true, command: "deliver" };
  });
  const visualCheck = vi.fn(async () => ({ ok: true, command: "visual-check" }));
  const sourceReceipt = { scope: "repository" as const, directories: 1, files: sources.length, bytes: 100 };
  const input = { run, product, sources, specVersionId: 7, sourceReceipt };
  return { root, save, deliver, visualCheck, input, services: { root, save, deliver, visualCheck, repoRoot: () => undefined } };
}

describe("repository architecture versions", () => {
  it("persists facts and coverage before standard Archify delivery", async () => {
    const { root, input, services, deliver, save } = fixture();
    const result = await generateRepositoryArchitectureVersion(input, services);
    expect(result).toMatchObject({ status: "accepted", errorMessage: null });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ quality: "standard", repoRoot: undefined }));
    expect(JSON.parse(result.specJson).meta.quality_profile).toBe("standard");
    expect(result.analysisReceipt).toMatchObject({ engine: "repository-facts-v1", source: input.sourceReceipt, coverage: { publishable: true } });
    const facts = JSON.parse(readFileSync(join(root, "artifacts/products/repo/7/architecture.facts.json"), "utf8"));
    const analysis = JSON.parse(readFileSync(join(root, "artifacts/products/repo/7/architecture.analysis.json"), "utf8"));
    expect(facts.revision).toBe(run.afterSha);
    expect(facts.nodes.length).toBeGreaterThan(1);
    expect(analysis.source).toEqual(input.sourceReceipt);
    expect(analysis.version).toBe(1);
    expect(analysis.coverage.publishable).toBe(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: "accepted", analysisReceipt: result.analysisReceipt }));
  });

  it("writes diagnostics but does not render an architecture with uncovered critical signals", async () => {
    const sources = [...nextSources, { path: "internal/client.go", content: "1: http.Get(\"/api/unregistered\")" }];
    const { root, input, services, deliver, visualCheck } = fixture(sources);
    const result = await generateRepositoryArchitectureVersion(input, services);
    expect(result).toMatchObject({ status: "failed", specJson: "", artifactPath: null });
    expect(result.errorMessage).toContain("Architecture coverage is not publishable: missing signal");
    expect(deliver).not.toHaveBeenCalled();
    expect(visualCheck).not.toHaveBeenCalled();
    expect(existsSync(join(root, "artifacts/products/repo/7/architecture.json"))).toBe(false);
    const analysis = JSON.parse(readFileSync(join(root, "artifacts/products/repo/7/architecture.analysis.json"), "utf8"));
    expect(analysis.coverage.publishable).toBe(false);
    expect(analysis.coverage.unclassifiedCriticalSignals).toHaveLength(1);
  });

  it("retains analysis receipts when spec persistence fails after diagnostics", async () => {
    const { root, input, services, deliver } = fixture();
    mkdirSync(join(root, "artifacts/products/repo/7/architecture.json"), { recursive: true });
    const result = await generateRepositoryArchitectureVersion(input, services);
    expect(result.status).toBe("failed");
    expect(result.analysisReceipt).toMatchObject({ engine: "repository-facts-v1", coverage: { publishable: true } });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails closed when the source receipt does not match the complete inventory", async () => {
    const { input, services, deliver, save } = fixture();
    const result = await generateRepositoryArchitectureVersion({ ...input, sourceReceipt: { ...input.sourceReceipt, files: 99 } }, services);
    expect(result).toMatchObject({ status: "failed", errorMessage: "Architecture source receipt does not match the complete source inventory" });
    expect(deliver).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });
});
