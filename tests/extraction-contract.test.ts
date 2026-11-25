import { describe, expect, it, vi } from "vitest";
import { analyzeWithAI, parseAnalysisContent } from "../lib/ai";
import { buildAnalysisMessages, buildExtractionWorkOrder, CONTRACT_VERSION } from "../lib/extraction-contract";

const sources = [{ path: "lib/feature.ts", content: "1: export const feature = true;" }];
const change = { message: "Add feature", committedAt: "2026-11-01T00:00:00Z", url: "", files: [{ path: "lib/feature.ts", status: "modified", patch: "+feature" }] };
const context = { outputLanguage: "zh-CN" as const, partition: { index: 1, total: 1 } };
const validResult = JSON.stringify({
  product: { description: "Test product", evidence: [{ path: "lib/feature.ts", startLine: 1 }] },
  release: { title: "Feature", summary: "Feature summary" },
  changes: [],
  features: [{ name: "Feature", summary: "Feature summary", scenarios: [{ reference: "HP-1", context: "User", action: "Uses feature", outcome: "Succeeds", category: "happy", evidence: [{ path: "lib/feature.ts", startLine: 1 }] }] }],
});

describe("extraction work-order contract", () => {
  it("uses identical messages through the work order and analyzeWithAI", async () => {
    const workOrder = buildExtractionWorkOrder({ id: "partition-001", sources, change, context });
    const client = { complete: vi.fn(async () => validResult) };

    await analyzeWithAI(sources, change, { ...context, client });

    expect(workOrder.contractVersion).toBe(CONTRACT_VERSION);
    expect(workOrder.id).toBe("partition-001");
    expect(workOrder.messages).toEqual(buildAnalysisMessages(sources, change, context));
    expect(client.complete).toHaveBeenCalledWith(workOrder.messages);
    expect(workOrder.sources).toEqual(sources);
    expect(workOrder.allowPaths).toEqual(["lib/feature.ts"]);
  });

  it("keeps migration scripts out of the allow paths and out of the prompt", () => {
    const withMigration = { ...change, files: [...change.files, { path: "migrations/001_init.sql", status: "modified", patch: "+ALTER TABLE features ADD COLUMN note VARCHAR(255);" }] };
    const workOrder = buildExtractionWorkOrder({ id: "partition-002", sources, change: withMigration, context });
    expect(workOrder.allowPaths).toEqual(["lib/feature.ts"]);
    // 迁移脚本对提示词没有贡献：带不带它，消息逐字节相同。
    expect(workOrder.messages).toEqual(buildAnalysisMessages(sources, change, context));
  });

  it("rejects missing required release fields", () => {
    const result = JSON.parse(validResult);
    result.release.title = "";
    expect(() => parseAnalysisContent(JSON.stringify(result))).toThrow();
    result.release.title = "Feature";
    result.release.summary = "";
    expect(() => parseAnalysisContent(JSON.stringify(result))).toThrow();
  });
});
