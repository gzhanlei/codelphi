import "dotenv/config";

type Execute = (statement: string, parameters: Array<string | number | null>) => Promise<unknown>;

async function main() {
  const { getDb } = await import("../lib/db");
  const connection = (await getDb().getConnection()) as unknown as {
    beginTransaction(): Promise<unknown>;
    execute(s: string, p?: Array<string | number | null>): Promise<unknown>;
    rollback(): Promise<unknown>;
    commit(): Promise<unknown>;
    release(): void;
  };
  await connection.beginTransaction();
  const cases: Array<[string, string, Array<string | number | null>]> = [
    ["predicate tokens-convert", "SELECT (max_total_tokens = CONVERT(?, UNSIGNED)) AS t FROM analysis_run_budgets WHERE run_id = 6", ["18446744073709551615"]],
    ["predicate cost-convert", "SELECT (max_cost_amount = CONVERT(?, DECIMAL(12,6))) AS c FROM analysis_run_budgets WHERE run_id = 6", ["999999.999999"]],
    ["full update", `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls + ?,
            reserved_input_tokens = reserved_input_tokens + ?,
            reserved_output_tokens = reserved_output_tokens + ?,
            reserved_cost_amount = reserved_cost_amount + ?,
            summary_reserved = 1,
            version = version + 1
      WHERE run_id = ?
        AND summary_reserved = 0
        AND (max_llm_calls = ? OR settled_llm_calls + reserved_llm_calls + ? <= max_llm_calls)
        AND (max_total_tokens = CONVERT(?, UNSIGNED) OR settled_input_tokens + reserved_input_tokens + settled_output_tokens + reserved_output_tokens + ? <= max_total_tokens)
        AND (max_cost_amount = CONVERT(?, DECIMAL(12,6)) OR settled_cost_amount + reserved_cost_amount + ? <= max_cost_amount)`,
     [1, 128000, 8192, "5.000000", 6, 2147483647, 1, "18446744073709551615", 136192, "999999.999999", "5.000000"]],
    ["update without cost predicate", `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls + 1, version = version + 1
      WHERE run_id = 6
        AND summary_reserved = 0
        AND (max_llm_calls = ? OR settled_llm_calls + reserved_llm_calls + ? <= max_llm_calls)
        AND (max_total_tokens = CONVERT(?, UNSIGNED) OR 1 <= max_total_tokens)`,
     [2147483647, 1, "18446744073709551615"]],
    ["update without tokens predicate", `UPDATE analysis_run_budgets
        SET reserved_llm_calls = reserved_llm_calls + 1, version = version + 1
      WHERE run_id = 6
        AND summary_reserved = 0
        AND (max_llm_calls = ? OR 1 <= max_llm_calls)
        AND (max_cost_amount = CONVERT(?, DECIMAL(12,6)) OR 1 <= max_cost_amount)`,
     [2147483647, "999999.999999"]],
  ];
  for (const [label, sql, params] of cases) {
    try {
      await connection.execute(sql, params);
      console.log(`OK    ${label}`);
    } catch (error) {
      console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await connection.rollback().catch(() => undefined);
  connection.release();
  process.exit(0);
}

void main();
