import { defaultExecute, type Execute } from "../db";

/**
 * R5 成本分布观测（analysis-pipeline.md 成本特征节的 P1 项）：每 run 实际成本、
 * 按产品归集、P50/P95/P99 分位、影子/主链路与独立生成（call_kind）成本拆分。
 * 数据源 = llm_call_receipts（逐调用回执，成本可 NULL=未定价，汇总按 0 计入行但
 * 未定价调用数单独披露——未定价 ≠ 零成本）。
 */

export interface RunCostRow {
  runId: number;
  productName: string;
  mainCost: number;
  shadowCost: number;
  standaloneCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  unpricedCalls: number;
  createdAt: Date;
}

export interface CostObservabilityReport {
  windowDays: number;
  runCount: number;
  unpricedCalls: number;
  totalMainCost: number;
  totalShadowCost: number;
  totalStandaloneCost: number;
  /** 每 run 主链路成本分位（含影子不计入；未定价 run 计 0）。 */
  percentiles: { p50: number; p95: number; p99: number };
  /** 影子成本占总成本比（采样率评估用）。 */
  shadowShare: number;
  byProduct: Array<{ productName: string; runCount: number; mainCost: number; shadowCost: number; avgCostPerRun: number }>;
  runs: RunCostRow[];
}

export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const index = Math.min(sortedAscending.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1));
  return sortedAscending[index];
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export async function buildCostReport(execute: Execute = defaultExecute, windowDays = 14): Promise<CostObservabilityReport> {
  const runResult = await execute(
    `SELECT r.id AS runId, p.name AS productName, r.created_at AS createdAt,
            SUM(CASE WHEN c.charge_component = 'main' THEN c.llm_cost_amount ELSE 0 END) AS mainCost,
            SUM(CASE WHEN c.charge_component = 'platform_shadow' THEN c.llm_cost_amount ELSE 0 END) AS shadowCost,
            SUM(c.input_tokens) AS inputTokens, SUM(c.output_tokens) AS outputTokens,
            SUM(c.cache_hit_tokens) AS cacheHitTokens,
            SUM(CASE WHEN c.pricing_status = 'unpriced' THEN 1 ELSE 0 END) AS unpricedCalls
     FROM llm_call_receipts c
     JOIN analysis_runs r ON r.id = c.run_id
     JOIN repositories repo ON repo.id = r.repository_id
     JOIN products p ON p.id = repo.product_id
     WHERE c.created_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)
     GROUP BY r.id, p.name, r.created_at
     ORDER BY r.created_at DESC
     LIMIT 500`,
    [windowDays],
  ) as unknown;

  const standaloneResult = await execute(
    `SELECT COALESCE(c.call_kind, 'unknown') AS callKind, COUNT(*) AS calls,
            SUM(c.llm_cost_amount) AS cost,
            SUM(CASE WHEN c.pricing_status = 'unpriced' THEN 1 ELSE 0 END) AS unpricedCalls
     FROM llm_call_receipts c
     WHERE c.run_id IS NULL AND c.created_at >= DATE_SUB(NOW(3), INTERVAL ? DAY)
     GROUP BY c.call_kind`,
    [windowDays],
  ) as unknown;

  const runRowsRaw = (Array.isArray(runResult) ? (runResult as unknown[])[0] : runResult) as unknown;
  const runs = (Array.isArray(runRowsRaw) ? runRowsRaw : []) as Array<{
    runId: number; productName: string; mainCost: string | number | null; shadowCost: string | number | null;
    inputTokens: string | number | null; outputTokens: string | number | null; cacheHitTokens: string | number | null;
    unpricedCalls: string | number | null; createdAt: Date;
  }>;
  const standaloneRaw = (Array.isArray(standaloneResult) ? (standaloneResult as unknown[])[0] : standaloneResult) as unknown;
  const standalone = (Array.isArray(standaloneRaw) ? standaloneRaw : []) as Array<{
    callKind: string; calls: string | number; cost: string | number | null; unpricedCalls: string | number | null;
  }>;

  const runCostRows: RunCostRow[] = runs.map((row) => ({
    runId: Number(row.runId),
    productName: row.productName,
    mainCost: Number(row.mainCost ?? 0),
    shadowCost: Number(row.shadowCost ?? 0),
    standaloneCost: 0,
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    cacheHitTokens: Number(row.cacheHitTokens ?? 0),
    unpricedCalls: Number(row.unpricedCalls ?? 0),
    createdAt: row.createdAt,
  }));

  const totalStandaloneCost = standalone.reduce((sum, row) => sum + Number(row.cost ?? 0), 0);
  const standaloneUnpriced = standalone.reduce((sum, row) => sum + Number(row.unpricedCalls ?? 0), 0);
  const totalMain = runCostRows.reduce((sum, row) => sum + row.mainCost, 0);
  const totalShadow = runCostRows.reduce((sum, row) => sum + row.shadowCost, 0);
  const sortedMain = [...runCostRows.map((row) => row.mainCost)].sort((a, b) => a - b);
  const byProductMap = new Map<string, { productName: string; runCount: number; mainCost: number; shadowCost: number }>();
  for (const row of runCostRows) {
    const entry = byProductMap.get(row.productName) ?? { productName: row.productName, runCount: 0, mainCost: 0, shadowCost: 0 };
    entry.runCount += 1;
    entry.mainCost += row.mainCost;
    entry.shadowCost += row.shadowCost;
    byProductMap.set(row.productName, entry);
  }
  const unpricedCalls = runCostRows.reduce((sum, row) => sum + row.unpricedCalls, 0) + standaloneUnpriced;
  const totalAll = totalMain + totalShadow + totalStandaloneCost;
  return {
    windowDays,
    runCount: runCostRows.length,
    unpricedCalls,
    totalMainCost: round6(totalMain),
    totalShadowCost: round6(totalShadow),
    totalStandaloneCost: round6(totalStandaloneCost),
    percentiles: {
      p50: round6(percentile(sortedMain, 50)),
      p95: round6(percentile(sortedMain, 95)),
      p99: round6(percentile(sortedMain, 99)),
    },
    shadowShare: totalAll === 0 ? 0 : round6(totalShadow / totalAll),
    byProduct: [...byProductMap.values()]
      .map((entry) => ({ ...entry, mainCost: round6(entry.mainCost), shadowCost: round6(entry.shadowCost), avgCostPerRun: entry.runCount === 0 ? 0 : round6((entry.mainCost + entry.shadowCost) / entry.runCount) }))
      .sort((a, b) => b.mainCost + b.shadowCost - (a.mainCost + a.shadowCost)),
    runs: runCostRows.slice(0, 100),
  };
}
