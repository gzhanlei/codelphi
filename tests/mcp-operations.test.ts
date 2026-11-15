import { describe, expect, it, vi } from "vitest";
import { buildFeedbackLifecycle, buildReleaseHealth, waitForRelease } from "../lib/mcp/operations";

describe("buildFeedbackLifecycle", () => {
  it("keeps corrective analysis separate from unavailable verification", () => {
    const result = buildFeedbackLifecycle({
      id: 14,
      kind: "bug",
      status: "new",
      verdict: "needs_human",
      verdictReason: "需要人工",
      adjudicatedAt: new Date("2026-11-15T18:00:00Z"),
      githubIssueUrl: null,
      correctiveRunId: null,
      correctiveRunStatus: null,
      correctiveSha: null,
      regressionStableKey: null,
    });

    expect(result.correctiveAnalysis).toEqual({ sha: null, status: "not_run" });
    expect(result.verification).toEqual({
      status: "unavailable",
      verifiedAt: null,
      verifiedBy: null,
      verifiedReleaseId: null,
      verifiedSha: null,
      verifiedSpecVersionId: null,
    });
  });
});

describe("buildReleaseHealth", () => {
  it("returns scoped numerators, denominators, ratios and anomalies", () => {
    const result = buildReleaseHealth({
      totalReleaseCount: 200,
      eligibleReleaseCount: 167,
      linkedReleaseCount: 167,
      legacyReleaseCount: 0,
      eligibleChangeCount: 2239,
      sourceLinkedChangeCount: 2239,
      sourceLinkCount: 13699,
      orphanLinkCount: 0,
      lastAppliedMigration: { name: "075.sql", appliedAt: "2026-11-15T19:00:00Z" },
      lastAnalysisStatus: { runId: 333, status: "succeeded", afterSha: "abc", errorMessage: null },
    });

    expect(result.sourceLinkedRatio).toBe(1);
    expect(result.canonicalProjectionRatio).toBe(1);
    expect(result.eligibleChangeCount).toBe(2239);
    expect(result.orphanLinkCount).toBe(0);
    expect(result.duplicateFeatureClusterCount).toBeNull();
    expect(result.duplicateScenarioClusterCount).toBeNull();
  });

  it("uses null instead of zero for undefined ratios", () => {
    const result = buildReleaseHealth({
      totalReleaseCount: 0,
      eligibleReleaseCount: 0,
      linkedReleaseCount: 0,
      legacyReleaseCount: 0,
      eligibleChangeCount: 0,
      sourceLinkedChangeCount: 0,
      sourceLinkCount: 0,
      orphanLinkCount: 0,
      lastAppliedMigration: null,
      lastAnalysisStatus: null,
    });
    expect(result.sourceLinkedRatio).toBeNull();
    expect(result.canonicalProjectionRatio).toBeNull();
  });
});

describe("waitForRelease", () => {
  it("requires both run success and a persisted release with the exact SHA", async () => {
    const loadAttempt = vi.fn()
      .mockResolvedValueOnce({ analysisRunId: 333, analysisStatus: "running", analysisError: null, releaseId: null })
      .mockResolvedValueOnce({ analysisRunId: 333, analysisStatus: "succeeded", analysisError: null, releaseId: 231 });

    const result = await waitForRelease({
      sha: "abc1234",
      timeoutSeconds: 2,
      pollSeconds: 1,
      loadAttempt,
      sleep: vi.fn(async () => undefined),
    });

    expect(result).toEqual({ status: "completed", releaseId: 231, sha: "abc1234", analysisRunId: 333, analysisStatus: "succeeded", error: null });
    expect(loadAttempt).toHaveBeenCalledTimes(2);
  });

  it("returns failure for the latest failed attempt instead of an older success", async () => {
    const result = await waitForRelease({
      sha: "abc1234",
      timeoutSeconds: 1,
      pollSeconds: 1,
      loadAttempt: vi.fn(async () => ({ analysisRunId: 334, analysisStatus: "failed", analysisError: "boom", releaseId: 231 })),
      sleep: vi.fn(),
    });
    expect(result.status).toBe("failed");
    expect(result.analysisRunId).toBe(334);
    expect(result.error).toBe("boom");
  });

  it("returns timeout without treating a missing run as success", async () => {
    const result = await waitForRelease({
      sha: "abc1234",
      timeoutSeconds: 0,
      pollSeconds: 1,
      loadAttempt: vi.fn(async () => ({ analysisRunId: null, analysisStatus: null, analysisError: null, releaseId: null })),
      sleep: vi.fn(),
    });
    expect(result).toEqual({ status: "timeout", releaseId: null, sha: "abc1234", analysisRunId: null, analysisStatus: null, error: null });
  });
});
