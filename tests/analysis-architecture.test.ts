import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import { saveAnalysisAndArchitecture, type RunContext } from "../lib/analysis";

const run: RunContext = { id: 8, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: "a", afterSha: "b", connectionId: null, provider: "github", organizationId: 1, productSlug: "radar", productName: "Radar" };
const result: AnalysisResult = { product: { description: "Product summary", evidence: [{ path: "lib/analysis.ts", startLine: 1 }] }, release: { title: "Title", summary: "Summary" }, changes: [], features: [] };
const change = { message: "change", committedAt: "2026-11-01T00:00:00Z", url: "https://example.com/commit/b", files: [] };
const sources = [{ path: "lib/ai.ts", content: "1: code" }];
const sourceReceipt = { scope: "repository" as const, directories: 1, files: 1, bytes: 10 };
const architecture = { sources, sourceReceipt };

describe("analysis architecture pipeline", () => {
  it("saves the spec before generating architecture", async () => {
    const events: string[] = [];
    const saveResult = vi.fn(async () => { events.push("spec"); return 7; });
    const generateArchitecture = vi.fn(async () => { events.push("architecture"); return { status: "accepted" as const }; });
    const output = await saveAnalysisAndArchitecture(run, result, change, architecture, { saveResult, generateArchitecture });
    expect(output).toEqual({ specVersionId: 7, architectureError: null });
    expect(events).toEqual(["spec", "architecture"]);
    expect(generateArchitecture).toHaveBeenCalledWith({ run, sources, sourceReceipt, specVersionId: 7 });
  });

  it("loads architecture evidence after saving the spec and isolates loader failures", async () => {
    const events: string[] = [];
    const saveResult = vi.fn(async () => { events.push("spec"); return 7; });
    const generateArchitecture = vi.fn(async () => { events.push("architecture"); return { status: "accepted" as const }; });
    const loadSources = vi.fn(async () => { events.push("load"); return architecture; });
    const output = await saveAnalysisAndArchitecture(run, result, change, loadSources, { saveResult, generateArchitecture });
    expect(output).toEqual({ specVersionId: 7, architectureError: null });
    expect(events).toEqual(["spec", "load", "architecture"]);

    const failedLoad = vi.fn(async () => { throw new Error("Architecture evidence incomplete: mysql"); });
    const recordFailure = vi.fn(async () => undefined);
    const failed = await saveAnalysisAndArchitecture(run, result, change, failedLoad, { saveResult, generateArchitecture: vi.fn(), recordFailure });
    expect(failed).toEqual({ specVersionId: 7, architectureError: "Architecture evidence incomplete: mysql" });
    expect(recordFailure).toHaveBeenCalledWith({ run, specVersionId: 7, errorMessage: "Architecture evidence incomplete: mysql" });
    expect(saveResult).toHaveBeenCalledTimes(2);
  });

  it("does not roll back a saved spec when architecture generation fails unexpectedly", async () => {
    const saveResult = vi.fn(async () => 7);
    const generateArchitecture = vi.fn(async () => { throw new Error("CLI unavailable"); });
    const recordFailure = vi.fn(async () => undefined);
    const output = await saveAnalysisAndArchitecture(run, result, change, architecture, { saveResult, generateArchitecture, recordFailure });
    expect(output).toEqual({ specVersionId: 7, architectureError: "CLI unavailable" });
    expect(recordFailure).toHaveBeenCalledWith({ run, specVersionId: 7, errorMessage: "CLI unavailable" });
  });

  it("surfaces a persisted non-accepted architecture without rolling back the spec", async () => {
    const saveResult = vi.fn(async () => 7);
    const generateArchitecture = vi.fn(async () => ({ status: "failed" as const, errorMessage: "Architecture coverage is not publishable" }));
    const output = await saveAnalysisAndArchitecture(run, result, change, architecture, { saveResult, generateArchitecture });
    expect(output).toEqual({ specVersionId: 7, architectureError: "Architecture coverage is not publishable" });
    expect(saveResult).toHaveBeenCalledOnce();
  });

  it("uses a readable fallback for an empty architecture error", async () => {
    const output = await saveAnalysisAndArchitecture(run, result, change, architecture, {
      saveResult: vi.fn(async () => 7),
      generateArchitecture: vi.fn(async () => ({ status: "rendered" as const, errorMessage: "" })),
    });
    expect(output.architectureError).toBe("Architecture rendered");
  });
});
