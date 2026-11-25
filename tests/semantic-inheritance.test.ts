import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import type { StructuredCompletionMessage } from "../lib/llm-client";
import { applyReviewDecisions, continuityAgainstBaseline, parseSemanticArgs, planSemanticWindow, reconcileSemanticAnalysis, runSemanticWindow, transitionVerification, type ReviewDecision, type SemanticInheritanceWindow } from "../scripts/semantic-inheritance";

const window: SemanticInheritanceWindow = {
  id: "TEST-001",
  project: "Example",
  repository: "https://example.com/repo.git",
  baseSha: "base",
  targetSha: "target",
  declaredIntent: "test change",
  evidence: [
    { path: "src/a.ts", symbols: ["a"] },
    { path: "src/b.ts", symbols: ["b"] },
    { path: "server/static/assets/generated.js", symbols: [] },
    { path: "git-tree", symbols: ["tree"] },
  ],
};

const change = {
  message: "change a",
  files: [
    { path: "src/a.ts", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
    { path: "server/static/assets/generated.js", status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" },
  ],
};

function response(path = "src/a.ts") {
  return JSON.stringify({
    product: { description: "Example product", evidence: [{ path, startLine: 1 }] },
    release: { title: "test", summary: "test" },
    changes: [],
    features: [{
      name: "Example feature",
      summary: "Example summary",
      scenarios: [{
        reference: "HP-1",
        context: "context",
        action: "action",
        outcome: "outcome",
        category: "happy",
        evidence: [{ path, startLine: 1 }],
      }],
    }],
  });
}

describe("parseSemanticArgs", () => {
  it("defaults to dry-run and requires explicit execution and repository inputs", () => {
    expect(parseSemanticArgs(["--window", "TF-002", "--repo", "/tmp/repo"])).toMatchObject({
      windowId: "TF-002",
      repoDir: "/tmp/repo",
      execute: false,
    });
    expect(parseSemanticArgs(["--window", "TF-002", "--repo", "/tmp/repo", "--execute"])).toMatchObject({ execute: true });
    expect(() => parseSemanticArgs([])).toThrow("--window is required");
    expect(() => parseSemanticArgs(["--window", "TF-002"])).toThrow("--repo is required");
  });
});

describe("planSemanticWindow", () => {
  it("limits the diff arm to changed source and excludes generated assets from every arm", () => {
    const plan = planSemanticWindow(window, change.files.map((file) => file.path));

    expect(plan.baselinePaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plan.arms.full_rebuild).toEqual(["src/a.ts", "src/b.ts"]);
    expect(plan.arms.diff_only).toEqual(["src/a.ts"]);
    expect(plan.arms.semantic_inheritance).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("carries prior-chain evidence into the baseline without adding it to the diff arm", () => {
    const priorWindow = {
      ...window,
      id: "TEST-000",
      evidence: [{ path: "src/legacy.ts", symbols: ["legacy"] }],
    };
    const plan = planSemanticWindow(window, change.files.map((file) => file.path), [priorWindow]);

    expect(plan.baselinePaths).toEqual(["src/a.ts", "src/b.ts", "src/legacy.ts"]);
    expect(plan.arms.full_rebuild).toEqual(["src/a.ts", "src/b.ts", "src/legacy.ts"]);
    expect(plan.arms.diff_only).toEqual(["src/a.ts"]);
    expect(plan.arms.semantic_inheritance).toEqual(["src/a.ts", "src/b.ts", "src/legacy.ts"]);
  });
});

describe("continuityAgainstBaseline", () => {
  it("counts exact scenario preservation, missing identities and new identities", () => {
    const baseline = JSON.parse(response()) as AnalysisResult;
    const candidate = JSON.parse(response()) as AnalysisResult;
    candidate.features[0].scenarios.push({
      reference: "EC-1",
      context: "new context",
      action: "new action",
      outcome: "new outcome",
      category: "edge",
      evidence: [{ path: "src/a.ts", startLine: 1 }],
    });
    baseline.features[0].scenarios.push({
      reference: "EC-2",
      context: "missing context",
      action: "missing action",
      outcome: "missing outcome",
      category: "edge",
      evidence: [{ path: "src/a.ts", startLine: 1 }],
    });

    expect(continuityAgainstBaseline(baseline, candidate)).toEqual({
      baselineScenarios: 2,
      exactPreservedScenarios: 1,
      missingScenarios: 1,
      newScenarios: 1,
      changedScenarios: 0,
      exactPreservationRate: 0.5,
    });
  });

  it("counts same-reference rewrites as identity collisions rather than new scenarios", () => {
    const baseline = JSON.parse(response()) as AnalysisResult;
    const candidate = JSON.parse(response()) as AnalysisResult;
    candidate.features[0].scenarios[0].outcome = "a different behavior";

    expect(continuityAgainstBaseline(baseline, candidate)).toEqual({
      baselineScenarios: 1,
      exactPreservedScenarios: 0,
      missingScenarios: 0,
      newScenarios: 0,
      changedScenarios: 1,
      exactPreservationRate: 0,
    });
  });
});

describe("reconcileSemanticAnalysis", () => {
  it("quarantines same-reference rewrites and uncovered reviewed behaviors", () => {
    const baseline = JSON.parse(response()) as AnalysisResult;
    const inherited = JSON.parse(response()) as AnalysisResult;
    const coveredScenario = {
      reference: "EC-1",
      context: "covered context",
      action: "covered action",
      outcome: "covered outcome",
      category: "edge" as const,
      evidence: [{ path: "src/a.ts", startLine: 1 }],
    };
    baseline.features[0].scenarios.push(coveredScenario);
    inherited.features[0].scenarios.push(coveredScenario);
    inherited.features[0].scenarios[0].outcome = "different behavior";
    inherited.changes = [
      {
        featureName: "Mobile links",
        kind: "reviewed" as const,
        description: "new mobile behavior",
        userImpact: "",
        evidence: [{ path: "mobile/Links.kt", startLine: 1 }],
      },
      {
        featureName: "Covered implementation",
        kind: "reviewed" as const,
        description: "covered implementation",
        userImpact: "",
        evidence: [{ path: "src/a.ts", startLine: 1 }],
      },
    ];

    const reconciled = reconcileSemanticAnalysis(baseline, inherited);

    expect(reconciled.analysis.features[0].scenarios.map((scenario) => scenario.reference)).toEqual(["EC-1"]);
    expect(reconciled.reviewQueue.identityCollisions).toHaveLength(1);
    expect(reconciled.reviewQueue.identityCollisions[0]).toMatchObject({
      featureName: "Example feature",
      reference: "HP-1",
      status: "pending_identity_review",
    });
    expect(reconciled.reviewQueue.newBehaviorCandidates).toHaveLength(1);
    expect(reconciled.reviewQueue.newBehaviorCandidates[0]).toMatchObject({
      featureName: "Mobile links",
      status: "pending_behavior_review",
    });
  });
});

describe("runSemanticWindow", () => {
  it("isolates the three arms and reuses the base analysis on a later run", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "semantic-inheritance-"));
    const messages: StructuredCompletionMessage[][] = [];
    const sources: Record<string, string> = {
      "base:src/a.ts": "const a = 1;\n",
      "base:src/b.ts": "const b = 1;\n",
      "target:src/a.ts": "const a = 2;\n",
      "target:src/b.ts": "const b = 1;\n",
    };
    const options = {
      window,
      change,
      outputDir,
      readFile: async (sha: string, filePath: string) => sources[`${sha}:${filePath}`] ?? null,
      client: {
        async complete(input: StructuredCompletionMessage[]) {
          messages.push(input);
          return response();
        },
      },
    };

    const first = await runSemanticWindow(options);
    const second = await runSemanticWindow(options);

    expect(first.baselineReused).toBe(false);
    expect(first.modelCalls).toBe(4);
    expect(second.baselineReused).toBe(true);
    expect(second.modelCalls).toBe(3);
    expect(messages).toHaveLength(7);
    expect(messages[1][1].content).toContain("【本次提交】\nchange a");
    expect(messages[1][1].content).toContain("1: const a = 2;");
    expect(messages[1][1].content).toContain("src/b.ts");
    expect(messages[2][1].content).not.toContain("src/b.ts");
    expect(messages[2][1].content).not.toContain("上一版规格全文");
    expect(messages[3][1].content).toContain("上一版规格全文");
    expect(messages[3][1].content).toContain("Example feature");
    expect(messages[3][1].content).toContain("src/b.ts");

    const manifest = JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")) as { status: string; arms: string[] };
    expect(manifest.status).toBe("succeeded");
    expect(manifest.arms).toEqual(["full_rebuild", "diff_only", "semantic_inheritance"]);
  });
});


describe("runSemanticWindow review gates", () => {
  it("marks the run review_required instead of silently accepting collisions and uncovered candidates", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "semantic-inheritance-review-"));
    let call = 0;
    await runSemanticWindow({
      window,
      change,
      outputDir,
      readFile: async (sha, filePath) => `${sha}:${filePath}\n`,
      client: {
        async complete() {
          call += 1;
          if (call < 4) return response();
          const inherited = JSON.parse(response()) as AnalysisResult;
          inherited.features[0].scenarios[0].outcome = "different behavior";
          inherited.changes = [{
            featureName: "Mobile links",
            kind: "reviewed",
            description: "new mobile behavior",
            userImpact: "",
            evidence: [{ path: "mobile/Links.kt", startLine: 1 }],
          }];
          return JSON.stringify(inherited);
        },
      },
    });

    const manifest = JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")) as { status: string };
    const queue = JSON.parse(await readFile(path.join(outputDir, "review_queue.json"), "utf8")) as {
      identityCollisions: unknown[];
      newBehaviorCandidates: unknown[];
    };
    expect(manifest.status).toBe("review_required");
    expect(queue.identityCollisions).toHaveLength(1);
    expect(queue.newBehaviorCandidates).toHaveLength(1);
  });
});


describe("applyReviewDecisions", () => {
  it("promotes candidates as unverified scenarios and resolves collisions with a new identity", () => {
    const baseline = JSON.parse(response()) as AnalysisResult;
    const inherited = JSON.parse(response()) as AnalysisResult;
    inherited.features[0].scenarios[0].outcome = "different behavior";
    inherited.changes = [{
      featureName: "Mobile links",
      kind: "reviewed",
      description: "new mobile behavior",
      userImpact: "",
      evidence: [{ path: "mobile/Links.kt", startLine: 1 }],
    }];
    const { analysis, reviewQueue } = reconcileSemanticAnalysis(baseline, inherited);
    const decisions: ReviewDecision[] = [
      {
        type: "promote_candidate",
        candidateFeatureName: "Mobile links",
        targetFeature: { name: "Mobile links", summary: "Mobile summary" },
        scenarios: [{
          reference: "HP-1",
          context: "mobile context",
          action: "mobile action",
          outcome: "mobile outcome",
          category: "happy",
          evidence: [{ path: "mobile/Links.kt", startLine: 1 }],
        }],
        changeOrigin: "current_commit",
        rationale: "frozen prelabel and code evidence",
        reviewedBy: "ai_prelabel_review",
        reviewedAt: "2026-11-24T00:00:00Z",
      },
      {
        type: "resolve_collision",
        featureName: "Example feature",
        reference: "HP-1",
        targetFeatureName: "Example feature",
        scenario: {
          reference: "EC-4",
          context: "partner context",
          action: "partner action",
          outcome: "partner outcome",
          category: "edge",
          evidence: [{ path: "src/a.ts", startLine: 1 }],
        },
        changeOrigin: "preexisting_discovery",
        rationale: "new identity, not a rewrite of HP-1",
        reviewedBy: "ai_prelabel_review",
        reviewedAt: "2026-11-24T00:00:00Z",
      },
    ];

    const result = applyReviewDecisions(analysis, reviewQueue, decisions);

    expect(result.reviewQueue.status).toBe("resolved");
    expect(result.reviewQueue.identityCollisions).toHaveLength(0);
    expect(result.reviewQueue.newBehaviorCandidates).toHaveLength(0);
    expect(result.analysis.features.map((feature) => feature.name)).toContain("Mobile links");
    expect(result.analysis.features[0].scenarios.map((scenario) => scenario.reference)).toEqual(["EC-4"]);
    expect(result.verification).toHaveLength(2);
    expect(result.verification.every((item) => item.state === "unverified")).toBe(true);
    expect(result.verification.map((item) => item.changeOrigin)).toEqual(["current_commit", "preexisting_discovery"]);
  });

  it("rejects an internal-only candidate without adding product behavior", () => {
    const baseline = JSON.parse(response()) as AnalysisResult;
    const inherited = JSON.parse(response()) as AnalysisResult;
    inherited.changes = [{
      featureName: "Test documentation",
      kind: "reviewed",
      description: "test command only",
      userImpact: "",
      evidence: [{ path: "tests/README.md", startLine: 1 }],
    }];
    const { analysis, reviewQueue } = reconcileSemanticAnalysis(baseline, inherited);

    const result = applyReviewDecisions(analysis, reviewQueue, [{
      type: "reject_candidate",
      candidateFeatureName: "Test documentation",
      rationale: "test infrastructure only",
      reviewedBy: "ai_prelabel_review",
      reviewedAt: "2026-11-24T00:00:00Z",
    }]);

    expect(result.reviewQueue.status).toBe("resolved");
    expect(result.analysis.features).toEqual(baseline.features);
    expect(result.verification).toEqual([]);
    expect(result.reviewQueue.decisions[0]).toMatchObject({ type: "reject_candidate" });
  });
});


describe("transitionVerification", () => {
  const verified = {
    state: "verified" as const,
    specVersionId: 41,
    commitSha: "base-sha",
    verifiedAt: "2026-11-01T00:00:00Z",
    verifiedBy: "domain reviewer",
  };

  it("preserves current verification only for an unchanged behavior", () => {
    expect(transitionVerification(verified, "unchanged")).toEqual({
      current: verified,
      history: [verified],
    });
  });

  it("marks a previously verified behavior stale after relevant change", () => {
    expect(transitionVerification(verified, "behavior_changed").current.state).toBe("stale-verified");
    expect(transitionVerification(verified, "behavior_changed").history).toEqual([verified]);
  });

  it("keeps new and colliding behaviors unverified while preserving history", () => {
    expect(transitionVerification(verified, "new").current.state).toBe("unverified");
    expect(transitionVerification(verified, "identity_collision").current.state).toBe("unverified");
    expect(transitionVerification(verified, "identity_collision").history).toEqual([verified]);
  });

  it("does not automatically restore current verification on a tree revert", () => {
    expect(transitionVerification(verified, "tree_revert").current.state).toBe("stale-verified");
    expect(transitionVerification(verified, "tree_revert").history).toEqual([verified]);
  });
});
