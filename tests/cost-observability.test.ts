import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCostReport, percentile } from "../lib/billing/cost-observability";

const execute = vi.fn();

const runRows = [
  // 成本为字符串（MySQL DECIMAL 语义）
  { runId: 3, productName: "SalesBuddy", mainCost: "0.190000", shadowCost: "0.060000", inputTokens: 90000, outputTokens: 20000, cacheHitTokens: 81000, unpricedCalls: 0, createdAt: new Date("2026-11-10T08:00:00Z") },
  { runId: 2, productName: "SalesBuddy", mainCost: "0.070000", shadowCost: "0.000000", inputTokens: 30000, outputTokens: 8000, cacheHitTokens: 27000, unpricedCalls: 0, createdAt: new Date("2026-11-09T08:00:00Z") },
  { runId: 1, productName: "RepoMap", mainCost: "0.020000", shadowCost: null, inputTokens: 9000, outputTokens: 3000, cacheHitTokens: 0, unpricedCalls: 1, createdAt: new Date("2026-11-08T08:00:00Z") },
];

const standaloneRows = [{ callKind: "intro_material", calls: 2, cost: "0.120000", unpricedCalls: 1 }];

describe("cost observability (R5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execute.mockImplementation(async (sql: string) => {
      if (sql.includes("JOIN analysis_runs")) return [runRows, []];
      if (sql.includes("run_id IS NULL")) return [standaloneRows, []];
      return [[], []];
    });
  });

  it("percentile picks nearest-rank order statistics", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });

  it("aggregates per-run costs, splits shadow/standalone, and computes percentiles by product", async () => {
    const report = await buildCostReport(execute, 14);
    expect(report.runCount).toBe(3);
    expect(report.totalMainCost).toBe(0.28);
    expect(report.totalShadowCost).toBe(0.06);
    expect(report.totalStandaloneCost).toBe(0.12);
    expect(report.unpricedCalls).toBe(2);
    // P50 of [0.02, 0.07, 0.19] = 0.07；P95 = 0.19
    expect(report.percentiles.p50).toBe(0.07);
    expect(report.percentiles.p95).toBe(0.19);
    expect(report.shadowShare).toBeCloseTo(0.06 / 0.46, 5);
    const salesbuddy = report.byProduct.find((entry) => entry.productName === "SalesBuddy");
    expect(salesbuddy?.runCount).toBe(2);
    expect(salesbuddy?.avgCostPerRun).toBeCloseTo(0.16, 5);
    // byProduct 按总成本降序
    expect(report.byProduct[0].productName).toBe("SalesBuddy");
    expect(report.runs[0].runId).toBe(3);
  });

  it("returns an empty report when the window has no receipts", async () => {
    execute.mockImplementation(async () => [[], []]);
    const report = await buildCostReport(execute, 7);
    expect(report.runCount).toBe(0);
    expect(report.percentiles.p50).toBe(0);
    expect(report.shadowShare).toBe(0);
    expect(report.byProduct).toEqual([]);
  });
});
