import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult, analyzeWithAI } from "../lib/ai";
import type { AnalysisPartition } from "../lib/remote-analysis";
import { evidenceAllowSet, extractPassWithRetry, sanitizeEvidence } from "../lib/extraction-pass";

const result: AnalysisResult = {
  product: { description: "Test product", evidence: [{ path: "lib/feature.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [{ featureName: "Auth", kind: "reviewed", description: "Internal", userImpact: "", evidence: [{ path: "lib/change.ts" }] }],
  features: [{ name: "Auth", summary: "Auth", scenarios: [{ reference: "HP-1", context: "User", action: "Logs in", outcome: "Accepted", category: "happy", evidence: [{ path: "lib/feature.ts" }] }] }],
};

const partition = {
  slice: { files: [{ path: "lib/feature.ts" }] },
  sources: [{ path: "lib/feature.ts", content: "1: export const auth = true;" }],
} as AnalysisPartition;

const change = {
  message: "snapshot",
  committedAt: "2026-11-17T00:00:00Z",
  url: "",
  files: [{ path: "lib/change.ts", status: "modified", patch: "+change" }],
};

describe("shared extraction pass", () => {
  it("builds the evidence allow set from the actual partition and changed files", () => {
    expect(evidenceAllowSet(partition, change)).toEqual(new Set(["lib/feature.ts", "lib/change.ts"]));
  });

  it("leaves migration scripts out of the allow set even when the window changed them", () => {
    const withMigration = { ...change, files: [...change.files, { path: "migrations/090_add_gift_wallet.sql", status: "added", patch: "+CREATE TABLE gift_wallets (id BIGINT PRIMARY KEY);" }] };
    expect(evidenceAllowSet(partition, withMigration)).toEqual(new Set(["lib/feature.ts", "lib/change.ts"]));

    // 模型仍然引用了迁移脚本：这条场景没有可溯源的证据，整条剔除，不带着迁移证据进规格。
    const sanitized = structuredClone(result);
    sanitized.features[0].scenarios[0].evidence = [{ path: "migrations/090_add_gift_wallet.sql", startLine: 1 }];
    const summary = sanitizeEvidence(sanitized, evidenceAllowSet(partition, withMigration), "test");
    expect(sanitized.features).toEqual([]);
    expect(summary.droppedScenarios).toBe(1);
  });

  it("marks a pass whose candidates were all rejected without throwing", () => {
    const sanitized = structuredClone(result);
    sanitized.product.evidence = [{ path: "missing-product.ts" }];
    sanitized.changes[0].evidence = [{ path: "missing-change.ts" }];
    sanitized.features[0].scenarios[0].evidence = [{ path: "missing-feature.ts" }];
    const summary = sanitizeEvidence(sanitized, new Set(["lib/feature.ts"]), "test");
    expect(summary.allCandidatesRejected).toBe(true);
    expect(summary.empty).toBe(true);
    expect(sanitized.features).toEqual([]);
    expect(sanitized.changes).toEqual([]);
  });

  it("retries one failed extraction and preserves the original context", async () => {
    const analyze = vi.fn<typeof analyzeWithAI>()
      .mockRejectedValueOnce(new Error("temporary gateway failure"))
      .mockResolvedValueOnce(structuredClone(result));
    const context = { previousFeatureNames: ["Auth"], outputLanguage: "zh-CN" as const };
    const extracted = await extractPassWithRetry({
      sources: partition.sources,
      change,
      context,
      allowSet: new Set(["lib/feature.ts", "lib/change.ts"]),
      label: "test",
      analyze,
    });
    expect(extracted.pass.retries).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(analyze.mock.calls[0][2]).toBe(context);
    expect(analyze.mock.calls[1][2]).toBe(context);
  });

  it("fails after the second hard failure", async () => {
    const analyze = vi.fn<typeof analyzeWithAI>().mockRejectedValue(new Error("gateway unavailable"));
    await expect(extractPassWithRetry({
      sources: partition.sources,
      change,
      context: {},
      allowSet: new Set(["lib/feature.ts"]),
      label: "test",
      analyze,
    })).rejects.toThrow("gateway unavailable");
    expect(analyze).toHaveBeenCalledTimes(2);
  });
});
