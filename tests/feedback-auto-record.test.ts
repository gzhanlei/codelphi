import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();

vi.mock("@/lib/db", () => ({ getDb: () => ({ execute }) }));

import { recordRunFailureFeedback } from "../lib/feedback";

const run289 = '[\n  {\n    "expected": "array",\n    "code": "invalid_type",\n    "path": [\n      "features"\n    ],\n    "message": "Invalid input: expected array, received undefined"\n  }\n]';

const runFactsRows = [
  [
    {
      revision: "6ec05753df282348f83cc96ab613c6b2c649b72a",
      productId: 7,
      organizationId: 3,
      repositoryFullName: "gzhanlei/codelphi",
    },
  ],
];

describe("run failure auto-record to admin feedback backend", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue([[]]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("inserts a system-sourced report with the run id attached (reporter NULL)", async () => {
    execute.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM feedback_reports")) return Promise.resolve([[]]);
      if (sql.includes("FROM analysis_runs")) return Promise.resolve(runFactsRows);
      return Promise.resolve([{ insertId: 9 }]);
    });
    await recordRunFailureFeedback(289, run289);
    const insert = execute.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO feedback_reports")) as [string, unknown[]] | undefined;
    expect(insert).toBeDefined();
    const [fields, params] = insert!;
    expect(fields).toContain("analysis_run_id");
    // status 'new' 是 SQL 字面量，不在参数里
    expect(params).toEqual([3, 7, 289, "gzhanlei/codelphi", "6ec05753df282348f83cc96ab613c6b2c649b72a", run289]);
    // reporter_user_id 不在插入列里 = NULL（系统来源）
    expect(fields).not.toContain("reporter_user_id");
  });

  it("dedupes by product+revision+error_message like the user-submitted path", async () => {
    execute.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM feedback_reports")) return Promise.resolve([[{ id: 5 }]]);
      return Promise.resolve([[]]);
    });
    await recordRunFailureFeedback(289, run289);
    expect(execute.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO feedback_reports"))).toBe(false);
  });

  it("skips superseded runs (not a technical failure)", async () => {
    await recordRunFailureFeedback(290, "Analysis superseded by run 291");
    expect(execute).not.toHaveBeenCalled();
  });

  it("skips silently when the run row is missing", async () => {
    execute.mockResolvedValue([[]]);
    await recordRunFailureFeedback(999, run289);
    expect(execute.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO feedback_reports"))).toBe(false);
  });

  it("swallows its own failures so the run failure path is never disturbed", async () => {
    execute.mockRejectedValue(new Error("db down"));
    await expect(recordRunFailureFeedback(289, run289)).resolves.toBeUndefined();
  });
});
