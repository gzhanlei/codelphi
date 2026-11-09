/**
 * W0-5 成本与配额复核（docs/specsight-gap-improvement-plan.md §3.2）：
 * 一次多趟 run 的账单三方对账——billing_settlement_requests（run 级结算请求）、
 * billing_settlements（attempt 级闭合记录）、llm_call_receipts（逐趟回执）。
 * 纯函数，SQL 取数在 scripts/reconcile-run-billing.ts。
 * 口径：SAU 结算每 run 一次（D8/D15），与趟数无关；逐趟成本只记 llm_call_receipts；
 * platform_shadow 是平台自担成本，不进 SAU 结算期望。
 * 与 lib/billing/reconcile.ts（每日全库对账，sweep 用）分工：本文件只对单个 run。
 */

export interface SettlementRequestRow {
  runId: number;
  requestedActualUnits: number;
  capturedUnitsTotal: number;
  releasedUnitsTotal: number;
  unfundedUnits: number;
  runSettlementStatus: string;
}

export interface SettlementRow {
  attempt: number;
  originalUnits: number;
  capturedUnits: number;
  releasedUnits: number;
}

export interface ReservationRow {
  attempt: number;
  walletId: number;
  reservedUnits: number;
}

export interface ReceiptRow {
  chargeComponent: string;
  outcome: string;
  usageStatus: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ReconcileInputs {
  settlementRequest: SettlementRequestRow | null;
  settlements: SettlementRow[];
  reservations: ReservationRow[];
  receipts: ReceiptRow[];
}

export interface ReconcileCheck {
  check: string;
  ok: boolean;
  detail?: string;
}

export interface ReconcileReport {
  ok: boolean;
  checks: ReconcileCheck[];
  receiptRowsByComponent: Record<string, number>;
  unfundedUnits: number;
}

export function reconcileRunBilling(input: ReconcileInputs): ReconcileReport {
  const checks: ReconcileCheck[] = [];

  checks.push({ check: "settlement_request_exists", ok: input.settlementRequest !== null });

  const capturedSum = input.settlements.reduce((total, row) => total + row.capturedUnits, 0);
  const releasedSum = input.settlements.reduce((total, row) => total + row.releasedUnits, 0);
  if (input.settlementRequest) {
    const request = input.settlementRequest;
    const totalsMatch = capturedSum === request.capturedUnitsTotal
      && releasedSum === request.releasedUnitsTotal
      && request.requestedActualUnits === request.capturedUnitsTotal + request.releasedUnitsTotal + request.unfundedUnits;
    checks.push({
      check: "settlement_totals_match_attempt_rows",
      ok: totalsMatch,
      detail: `request(captured=${request.capturedUnitsTotal}, released=${request.releasedUnitsTotal}, unfunded=${request.unfundedUnits}) vs attempts(captured=${capturedSum}, released=${releasedSum})`,
    });
    checks.push({ check: "sau_charged_once", ok: request.capturedUnitsTotal <= request.requestedActualUnits, detail: `captured=${request.capturedUnitsTotal} / requested=${request.requestedActualUnits}` });
  } else {
    checks.push({ check: "settlement_totals_match_attempt_rows", ok: false, detail: "no settlement request row" });
    checks.push({ check: "sau_charged_once", ok: false, detail: "no settlement request row" });
  }

  const receiptsByComponent: Record<string, number> = {};
  for (const receipt of input.receipts) {
    receiptsByComponent[receipt.chargeComponent] = (receiptsByComponent[receipt.chargeComponent] ?? 0) + 1;
  }
  checks.push({ check: "main_receipts_present", ok: (receiptsByComponent.main ?? 0) > 0, detail: `main=${receiptsByComponent.main ?? 0} 趟回执` });
  const unknownUsage = input.receipts.filter((receipt) => receipt.chargeComponent === "main" && receipt.usageStatus !== "known");
  checks.push({
    check: "no_unknown_usage_receipts",
    ok: unknownUsage.length === 0,
    detail: unknownUsage.length > 0 ? `${unknownUsage.length} 条 main 回执 usage 未知（禁止假设零成本）` : undefined,
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    receiptRowsByComponent: receiptsByComponent,
    unfundedUnits: input.settlementRequest?.unfundedUnits ?? 0,
  };
}
