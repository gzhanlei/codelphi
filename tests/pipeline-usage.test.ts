import { describe, expect, it } from "vitest";
import {
  aggregatePipelineUsage,
  assertBenchmarkDatabaseName,
  resolveBenchDatabaseUrl,
  type PipelineReceiptRow,
  type PipelineTaskRow,
} from "../lib/pipeline-usage";

const tasks: PipelineTaskRow[] = [
  { taskKey: "task-a", status: "extracted" },
  { taskKey: "task-b", status: "extracted" },
];

const receipts: PipelineReceiptRow[] = [
  { taskKey: "task-a", callStage: "describe" },
  { taskKey: "task-a", callStage: "judge" },
  { taskKey: "task-a", callStage: "semantic_repair" },
  { taskKey: null, callStage: "product_summary" },
  { taskKey: null, callStage: "product_summary" },
];

describe("aggregatePipelineUsage", () => {
  it("aggregates task stages separately and keeps product summary out of tasks", () => {
    expect(aggregatePipelineUsage(receipts, tasks)).toEqual({
      tasks: [{
        taskKey: "task-a",
        total: 3,
        describe: 1,
        judge: 1,
        semanticRepair: 1,
        reusedTerminal: false,
      }, {
        taskKey: "task-b",
        total: 0,
        describe: 0,
        judge: 0,
        semanticRepair: 0,
        reusedTerminal: true,
      }],
      productSummary: 2,
    });
  });

  it("marks terminal tasks without current-run receipts as reused", () => {
    expect(aggregatePipelineUsage([], tasks).tasks).toEqual([
      { taskKey: "task-a", total: 0, describe: 0, judge: 0, semanticRepair: 0, reusedTerminal: true },
      { taskKey: "task-b", total: 0, describe: 0, judge: 0, semanticRepair: 0, reusedTerminal: true },
    ]);
  });

  it("does not mark pending or failed tasks as reused terminal", () => {
    expect(aggregatePipelineUsage([], [{ taskKey: "task-a", status: "pending" }, { taskKey: "task-b", status: "failed" }]).tasks.map((task) => task.reusedTerminal)).toEqual([false, false]);
  });
});

describe("resolveBenchDatabaseUrl", () => {
  it("selects an explicit scratch database without exposing credentials", () => {
    expect(resolveBenchDatabaseUrl("mysql://user:pass@example.test/radar", "codelphi_bench_i1")).toBe("mysql://user:pass@example.test/codelphi_bench_i1");
    expect(() => resolveBenchDatabaseUrl("mysql://user:pass@example.test/radar", "radar")).toThrow(/scratch/);
  });
});

describe("assertBenchmarkDatabaseName", () => {
  it("accepts only the dedicated benchmark database names", () => {
    expect(() => assertBenchmarkDatabaseName("codelphi_bench")).not.toThrow();
    expect(() => assertBenchmarkDatabaseName("codelphi_bench_i0")).not.toThrow();
    expect(() => assertBenchmarkDatabaseName("radar")).toThrow(/scratch/);
  });
});
