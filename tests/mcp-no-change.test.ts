import { describe, expect, it, vi } from "vitest";
import { verifyNoChange } from "../lib/mcp/no-change";
import type { SourceLineRequest, SourceLineSlice } from "../lib/remote-source-index/types";
import type { SpecFeature } from "../lib/spec-diff";

function feature(name = "发布入口", reference = "HP-1"): SpecFeature {
  return {
    name,
    summary: "访客可以打开发布入口",
    scenarios: [{
      reference,
      context: "访客打开产品页",
      action: "点击发布入口",
      outcome: "进入发布流程",
      category: "happy",
      evidence: [{ path: "components/publish.tsx", startLine: 5, endLine: 6 }],
    }],
  };
}

function sourceSlice(request: SourceLineRequest, endLine = request.endLine): SourceLineSlice {
  return {
    path: request.path,
    blobSha: "blob",
    treeEntrySha: "blob",
    startLine: request.startLine,
    endLine,
    lines: Array.from({ length: Math.max(0, endLine - request.startLine + 1) }, () => "return <Publish />;"),
    byteSize: 20,
    lineCount: 10,
    verified: true,
    cacheState: "fetched",
    readReceipt: { requestedBy: request.requestedBy, reason: request.reason, fetchedAt: "2026-11-23T00:00:00.000Z" },
  };
}

describe("verifyNoChange", () => {
  it("verifies preserved identities, unchanged semantics and readable afterSha evidence", async () => {
    const readLines = vi.fn(async (request: SourceLineRequest) => sourceSlice(request));
    const result = await verifyNoChange({ baseFeatures: [feature()], currentFeatures: [feature()], index: { readLines } });

    expect(result.verified).toBe(true);
    expect(result).toMatchObject({ identityPreserved: true, semanticsUnchanged: true, conflictFree: true, evidenceComplete: true, evidenceTotal: 1, evidenceVerified: 1 });
    expect(readLines).toHaveBeenCalledWith(expect.objectContaining({ path: "components/publish.tsx", startLine: 5, endLine: 6, requestedBy: "evidence_verifier" }));
  });

  it("rejects identity loss instead of treating renamed removed and added entries as preservation", async () => {
    const result = await verifyNoChange({ baseFeatures: [feature()], currentFeatures: [feature("新的发布能力")], index: { readLines: vi.fn() } });

    expect(result.verified).toBe(false);
    expect(result.identityPreserved).toBe(false);
    expect(result.reasons).toContain("identity_not_preserved");
  });

  it("rejects an evidence anchor that cannot be fully read at afterSha", async () => {
    const readLines = vi.fn(async (request: SourceLineRequest) => sourceSlice(request, request.startLine));
    const result = await verifyNoChange({ baseFeatures: [feature()], currentFeatures: [feature()], index: { readLines } });

    expect(result.verified).toBe(false);
    expect(result.evidenceComplete).toBe(false);
    expect(result.evidenceVerified).toBe(0);
    expect(result.reasons).toContain("evidence_range_invalid");
  });

  it("rejects scenarios without a concrete evidence line anchor", async () => {
    const current = feature();
    current.scenarios[0].evidence = [{ path: "components/publish.tsx" }];
    const result = await verifyNoChange({ baseFeatures: [feature()], currentFeatures: [current], index: { readLines: vi.fn() } });

    expect(result.verified).toBe(false);
    expect(result.evidenceComplete).toBe(false);
    expect(result.reasons).toContain("evidence_anchor_missing");
  });
});
