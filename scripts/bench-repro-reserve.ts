import "dotenv/config";

async function main() {
  const { reserveProductSummaryBudget } = await import("../lib/behavior-run-budget");
  const { getDb } = await import("../lib/db");
  try {
    const r = await reserveProductSummaryBudget(6);
    console.log("RESERVE_OK:", JSON.stringify({ reservationId: r.reservationId, status: r.status }));
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.split("\n").slice(1, 5).join("\n")}` : String(error);
    console.log("RESERVE_FAIL:", message);
  }
  const db = getDb();
  const [rows] = (await db.execute("SELECT summary_reserved, reserved_input_tokens, version FROM analysis_run_budgets WHERE run_id = 6")) as unknown as [Array<Record<string, unknown>>, unknown];
  console.log("row:", JSON.stringify(rows[0]));
  process.exit(0);
}

void main();
