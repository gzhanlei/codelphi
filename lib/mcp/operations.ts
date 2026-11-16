export function buildFeedbackLifecycle(input: {
  id: number;
  kind: string | null;
  status: string | null;
  verdict: string | null;
  verdictReason: string | null;
  adjudicatedAt: Date | null;
  githubIssueUrl: string | null;
  correctiveRunId: number | null;
  correctiveRunStatus: string | null;
  correctiveSha: string | null;
  regressionStableKey: string | null;
}) {
  return {
    id: input.id,
    kind: input.kind,
    status: input.status,
    verdict: input.verdict,
    verdictReason: input.verdictReason,
    adjudicatedAt: input.adjudicatedAt,
    githubIssueUrl: input.githubIssueUrl,
    correctiveAnalysis: {
      sha: input.correctiveSha,
      status: input.correctiveRunId === null ? "not_run" : input.correctiveRunStatus === null ? "unknown" : input.correctiveRunStatus === "succeeded" ? "succeeded" : input.correctiveRunStatus === "failed" ? "failed" : "running",
    },
    regressionStableKey: input.regressionStableKey,
    verification: {
      status: "unavailable" as const,
      verifiedAt: null,
      verifiedBy: null,
      verifiedReleaseId: null,
      verifiedSha: null,
      verifiedSpecVersionId: null,
    },
  };
}

export function buildReleaseHealth(input: {
  totalReleaseCount: number;
  totalChangeCount?: number;
  eligibleReleaseCount: number;
  linkedReleaseCount: number;
  legacyReleaseCount: number;
  eligibleChangeCount: number;
  sourceLinkedChangeCount: number;
  sourceLinkCount: number;
  reviewedExcludedCount?: number;
  orphanLinkCount: number;
  lastAppliedMigration: { name: string; appliedAt: string } | null;
  lastAnalysisStatus: { runId: number; status: string; afterSha: string | null; errorMessage: string | null } | null;
}) {
  return {
    totalReleaseCount: input.totalReleaseCount,
    eligibleChangeCount: input.eligibleChangeCount,
    sourceLinkedChangeCount: input.sourceLinkedChangeCount,
    totalChangeCount: input.totalChangeCount ?? input.eligibleChangeCount,
    reviewedExcludedCount: input.reviewedExcludedCount ?? 0,
    sourceLinkedRatio: input.eligibleChangeCount === 0 ? null : input.sourceLinkedChangeCount / input.eligibleChangeCount,
    eligibleReleaseCount: input.eligibleReleaseCount,
    linkedReleaseCount: input.linkedReleaseCount,
    legacyReleaseCount: input.legacyReleaseCount,
    canonicalProjectionRatio: input.eligibleReleaseCount === 0 ? null : input.linkedReleaseCount / input.eligibleReleaseCount,
    duplicateFeatureClusterCount: null,
    duplicateScenarioClusterCount: null,
    duplicateFeatureRecordCount: null,
    duplicateScenarioRecordCount: null,
    sourceLinkCount: input.sourceLinkCount,
    orphanLinkCount: input.orphanLinkCount,
    lastAppliedMigration: input.lastAppliedMigration,
    lastAnalysisStatus: input.lastAnalysisStatus,
  };
}

export async function waitForRelease(input: {
  sha: string;
  timeoutSeconds?: number;
  pollSeconds?: number;
  loadAttempt: () => Promise<{
    analysisRunId: number | null;
    analysisStatus: string | null;
    analysisError: string | null;
    releaseId: number | null;
    candidateCount?: number;
  }>;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  if (!/^[0-9a-f]{7,64}$/i.test(input.sha)) throw new Error("sha must be a hexadecimal commit SHA");
  const timeoutSeconds = input.timeoutSeconds ?? 10;
  const pollSeconds = input.pollSeconds ?? 1;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 60) throw new Error("timeoutSeconds must be between 0 and 60");
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0 || pollSeconds > 5) throw new Error("pollSeconds must be greater than 0 and at most 5");
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (;;) {
    const attempt = await input.loadAttempt();
    if ((attempt.candidateCount ?? 1) > 1) {
      return { status: "review" as const, releaseId: null, sha: input.sha, analysisRunId: attempt.analysisRunId, analysisStatus: attempt.analysisStatus, error: null };
    }
    if (attempt.analysisStatus === "failed") {
      return { status: "failed" as const, releaseId: attempt.releaseId, sha: input.sha, analysisRunId: attempt.analysisRunId, analysisStatus: attempt.analysisStatus, error: attempt.analysisError };
    }
    if (attempt.analysisStatus === "succeeded" && attempt.releaseId !== null) {
      return { status: "completed" as const, releaseId: attempt.releaseId, sha: input.sha, analysisRunId: attempt.analysisRunId, analysisStatus: attempt.analysisStatus, error: null };
    }
    if (Date.now() >= deadline) {
      return { status: "timeout" as const, releaseId: attempt.releaseId, sha: input.sha, analysisRunId: attempt.analysisRunId, analysisStatus: attempt.analysisStatus, error: null };
    }
    await sleep(pollSeconds * 1_000);
  }
}
