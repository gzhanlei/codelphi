import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import { saveAnalysisAndArchitecture, type RunContext } from "../lib/analysis";

const run: RunContext = { id: 8, repositoryId: 3, productId: 4, owner: "gzhanlei", name: "radar", beforeSha: "a", afterSha: "b", connectionId: null, provider: "github", organizationId: 1, productSlug: "radar", productName: "Radar" };
const result: AnalysisResult = { release: { title: "Title", summary: "Summary" }, changes: [], features: [] };
const change = { message: "change", committedAt: "2026-11-01T00:00:00Z", url: "https://example.com/commit/b", files: [] };
const sources = [{ path: "lib/ai.ts", content: "1: code" }];

describe("analysis architecture pipeline", () => {
  it("saves the spec before generating architecture", async () => {
    const events: string[] = [];
    const saveResult = vi.fn(async () => { events.push("spec"); return 7; });
    const generateArchitecture = vi.fn(async () => { events.push("architecture"); return { status: "accepted" as const }; });
    const output = await saveAnalysisAndArchitecture(run, result, change, sources, { saveResult, generateArchitecture });
    expect(output).toEqual({ specVersionId: 7, architectureError: null });
    expect(events).toEqual(["spec", "architecture"]);
    expect(generateArchitecture).toHaveBeenCalledWith({ run, sources, specVersionId: 7 });
  });

  it("loads architecture evidence after saving the spec and isolates loader failures", async () => {
    const events: string[] = [];
    const saveResult = vi.fn(async () => { events.push("spec"); return 7; });
    const generateArchitecture = vi.fn(async () => { events.push("architecture"); return { status: "accepted" as const }; });
    const loadSources = vi.fn(async () => { events.push("load"); return sources; });
    const output = await saveAnalysisAndArchitecture(run, result, change, loadSources, { saveResult, generateArchitecture });
    expect(output).toEqual({ specVersionId: 7, architectureError: null });
    expect(events).toEqual(["spec", "load", "architecture"]);

    const failedLoad = vi.fn(async () => { throw new Error("Architecture evidence incomplete: mysql"); });
    const failed = await saveAnalysisAndArchitecture(run, result, change, failedLoad, { saveResult, generateArchitecture: vi.fn() });
    expect(failed).toEqual({ specVersionId: 7, architectureError: "Architecture evidence incomplete: mysql" });
    expect(saveResult).toHaveBeenCalledTimes(2);
  });

  it("does not roll back a saved spec when architecture generation fails unexpectedly", async () => {
    const saveResult = vi.fn(async () => 7);
    const generateArchitecture = vi.fn(async () => { throw new Error("CLI unavailable"); });
    const output = await saveAnalysisAndArchitecture(run, result, change, sources, { saveResult, generateArchitecture });
    expect(output).toEqual({ specVersionId: 7, architectureError: "CLI unavailable" });
  });
});
