import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import type { AnalysisCoverageReceipt } from "../lib/analysis-coverage";
import type { AnalysisPartition } from "../lib/remote-analysis";
import { buildSnapshotReportData } from "../lib/snapshot/report-data";
import type { SnapshotAnalysis, SnapshotIdentity } from "../lib/snapshot/types";

const identity: SnapshotIdentity = {
  source: "github",
  name: "repo",
  owner: "owner",
  target: "https://github.com/owner/repo",
  repositoryUrl: "https://github.com/owner/repo",
  revision: "b".repeat(40),
  branch: "main",
  message: "Snapshot",
  committedAt: "2026-11-17T00:00:00Z",
  workingTreeDirty: false,
};

const coverage: AnalysisCoverageReceipt = {
  implFilesAssembled: 1,
  implFilesTotal: 2,
  implBytesAssembled: 30,
  implBytesTotal: 60,
  coverageRatio: 0.5,
  partitionsUsed: 1,
  partitionsCapped: false,
  diffTotalPaths: null,
  diffSelectedPaths: null,
  diffOmittedPaths: null,
};

function analysis(result: AnalysisResult, sources = ["1: first line", "2: second line", "3: third line"]): SnapshotAnalysis {
  const partition = { slice: { files: [{ path: "src/index.ts" }] }, sources: [{ path: "src/index.ts", content: sources.join("\n") }] } as AnalysisPartition;
  return {
    identity,
    language: "en",
    generatedAt: "2026-11-17T01:00:00Z",
    modelName: "Host current model",
    result,
    partitions: [partition],
    index: {} as SnapshotAnalysis["index"],
    coverage,
    warnings: [],
    passes: [{ retries: 0, sanitize: { droppedClaims: 0, droppedScenarios: 0, droppedFeatures: 0, allCandidatesRejected: false, empty: false, keptClaims: 1 } }],
    mergeStats: { changesTruncated: 0, scenariosDeduped: 0, featuresFolded: 0 },
  };
}

function result(): AnalysisResult {
  return {
    product: { description: "Product", evidence: [{ path: "src/index.ts", startLine: 1 }] },
    release: { title: "Ignored", summary: "Ignored" },
    changes: [],
    features: [{ name: "Feature", summary: "Summary", scenarios: [{ reference: "HP-1", context: "Context", action: "Action", outcome: "Outcome", category: "happy", evidence: [{ path: "src/index.ts", startLine: 2, url: "https://evil.test/phish" }] }] }],
  };
}

describe("snapshot report data", () => {
  it("keeps language and snapshot identity while excluding release workflows", () => {
    const report = buildSnapshotReportData(analysis(result()));
    expect(report.schemaVersion).toBe(1);
    expect(report.language).toBe("en");
    expect(report.snapshot.revision).toBe(identity.revision);
    expect(report.features).toHaveLength(1);
    expect(report).not.toHaveProperty("release");
    expect(report.modelName).toBe("Host current model");
  });

  it("uses real numbered source lines and generates only trusted fixed-SHA GitHub links", () => {
    const report = buildSnapshotReportData(analysis(result()));
    expect(report.evidenceSnippets).toHaveLength(2);
    const scenarioSnippet = report.evidenceSnippets.find((snippet) => snippet.citedStartLine === 2);
    expect(scenarioSnippet?.lines[0]).toEqual({ number: 2, text: "second line" });
    expect(scenarioSnippet?.sourceUrl).toContain(`/${"b".repeat(40)}/src/index.ts#L2`);
    expect(scenarioSnippet?.sourceUrl).not.toContain("evil.test");
  });

  it("drops an untraceable product description instead of presenting it as fact", () => {
    const input = result();
    input.product.evidence = [];
    const report = buildSnapshotReportData(analysis(input));
    expect(report.product.description).toBeNull();
    expect(report.warnings.some((warning) => warning.code === "product_description_unavailable")).toBe(true);
  });

  it("deduplicates citations and makes line and byte truncation visible", () => {
    const input = result();
    input.features[0].scenarios[0].evidence.push({ path: "src/index.ts", startLine: 2 });
    const report = buildSnapshotReportData(analysis(input), { maxEvidenceLinesPerSnippet: 1, maxEvidenceBytes: 25 });
    expect(report.evidenceSnippets.length).toBeLessThan(3);
    expect(report.warnings.some((warning) => warning.code === "evidence_snippet_truncated" || warning.code === "evidence_budget_exceeded")).toBe(true);
    for (const snippet of report.evidenceSnippets) expect(snippet.lines.length).toBeLessThanOrEqual(1);
  });

  it("does not invent line numbers for unavailable or path-only evidence", () => {
    const input = result();
    input.features[0].scenarios[0].evidence = [{ path: "src/index.ts", startLine: 99 }, { path: "src/index.ts" }];
    const report = buildSnapshotReportData(analysis(input));
    const unavailable = report.evidenceSnippets.find((snippet) => snippet.citedStartLine === 99);
    expect(unavailable?.lines).toEqual([]);
    expect(unavailable?.unavailable).toBe(true);
    const pathOnly = report.evidenceSnippets.find((snippet) => snippet.citedStartLine === null);
    expect(pathOnly?.lines[0].number).toBe(1);
    expect(pathOnly?.citedStartLine).toBeNull();
  });
});
