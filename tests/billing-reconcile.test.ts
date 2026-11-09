import { describe, expect, it } from "vitest";
import { reconcileRunBilling, type ReconcileInputs } from "../lib/billing/run-reconcile";

const base: ReconcileInputs = {
  settlementRequest: { runId: 8, requestedActualUnits: 1, capturedUnitsTotal: 1, releasedUnitsTotal: 0, unfundedUnits: 0, runSettlementStatus: "fully_settled" },
  settlements: [{ attempt: 1, originalUnits: 1, capturedUnits: 1, releasedUnits: 0 }],
  reservations: [{ attempt: 1, walletId: 3, reservedUnits: 1 }],
  receipts: [
    { chargeComponent: "main", outcome: "success", usageStatus: "known", inputTokens: 45000, outputTokens: 3000 },
    { chargeComponent: "main", outcome: "success", usageStatus: "known", inputTokens: 47000, outputTokens: 2800 },
  ],
};

describe("run billing reconciliation (W0-5)", () => {
  it("passes a consistent multi-pass run: SAU once per run, receipts multi-row, no double charge", () => {
    const report = reconcileRunBilling(base);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ check: "settlement_request_exists", ok: true }),
      expect.objectContaining({ check: "settlement_totals_match_attempt_rows", ok: true }),
      expect.objectContaining({ check: "sau_charged_once", ok: true }),
      expect.objectContaining({ check: "main_receipts_present", ok: true }),
    ]));
  });

  it("flags a run with no settlement request (漏记)", () => {
    const report = reconcileRunBilling({ ...base, settlementRequest: null });
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ check: "settlement_request_exists", ok: false }));
  });

  it("flags settlement totals that disagree with attempt rows (重复计费 / 漏记)", () => {
    const report = reconcileRunBilling({
      ...base,
      settlements: [base.settlements[0], { attempt: 2, originalUnits: 1, capturedUnits: 1, releasedUnits: 0 }],
    });
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ check: "settlement_totals_match_attempt_rows", ok: false }));
  });

  it("flags an unfunded run and reports unfunded units", () => {
    const report = reconcileRunBilling({
      ...base,
      settlementRequest: { ...base.settlementRequest!, capturedUnitsTotal: 0, unfundedUnits: 1, runSettlementStatus: "unfunded" },
      settlements: [{ attempt: 1, originalUnits: 1, capturedUnits: 0, releasedUnits: 1 }],
    });
    expect(report.ok).toBe(false);
    expect(report.unfundedUnits).toBe(1);
  });

  it("flags a run with no main receipts (多趟 run 没有逐趟回执 = 漏记)", () => {
    const report = reconcileRunBilling({ ...base, receipts: [] });
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ check: "main_receipts_present", ok: false }));
  });

  it("counts platform_shadow receipts separately and excludes them from the SAU expectation", () => {
    const report = reconcileRunBilling({
      ...base,
      receipts: [...base.receipts, { chargeComponent: "platform_shadow", outcome: "success", usageStatus: "known", inputTokens: 40000, outputTokens: 3000 }],
    });
    expect(report.ok).toBe(true);
    expect(report.receiptRowsByComponent.platform_shadow).toBe(1);
    expect(report.receiptRowsByComponent.main).toBe(2);
  });

  it("flags failed main receipts with unknown usage (禁止假设零成本)", () => {
    const report = reconcileRunBilling({
      ...base,
      receipts: [base.receipts[0], { chargeComponent: "main", outcome: "timeout", usageStatus: "unknown", inputTokens: null, outputTokens: null }],
    });
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ check: "no_unknown_usage_receipts", ok: false }));
  });
});
