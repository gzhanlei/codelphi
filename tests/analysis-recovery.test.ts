import { beforeEach, describe, expect, it, vi } from "vitest";
import { orphanedRunMessage, recoverInterruptedRuns } from "../lib/analysis-recovery";

const execute = vi.fn();
const runAnalysis = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startup analysis recovery", () => {
  it("re-queues orphaned running runs and legacy orphan-failures, then re-dispatches the whole queue", async () => {
    execute
      .mockResolvedValueOnce([{ affectedRows: 2 }]) // running + 旧版本孤儿失败 → queued
      .mockResolvedValueOnce([[{ id: 51 }, { id: 57 }, { id: 64 }]]); // 派发队列
    const result = await recoverInterruptedRuns(runAnalysis, execute);
    expect(result).toEqual({ requeued: 2, dispatched: 3 });
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status = 'running' OR (status = 'failed' AND error_message = ?)"),
      [orphanedRunMessage],
    );
    expect(runAnalysis).toHaveBeenCalledTimes(3);
    expect(runAnalysis).toHaveBeenCalledWith(64);
  });

  it("never leaves an orphaned run visible as failed: the re-queue clears the error marker", async () => {
    execute
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ id: 92 }]]);
    await recoverInterruptedRuns(runAnalysis, execute);
    const requeueSql = execute.mock.calls[0][0] as string;
    expect(requeueSql).toContain("error_message = NULL");
    expect(requeueSql).toContain("finished_at = NULL");
  });

  it("does not resurrect genuinely failed runs (other error messages stay failed)", async () => {
    execute
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ id: 51 }]]);
    await recoverInterruptedRuns(runAnalysis, execute);
    const requeueSql = execute.mock.calls[0][0] as string;
    expect(requeueSql).not.toContain("WHERE status = 'failed' AND error_message IS NOT NULL");
  });

  it("keeps re-dispatching when one queued run fails immediately", async () => {
    execute
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[{ id: 51 }, { id: 57 }]]);
    runAnalysis.mockRejectedValueOnce(new Error("boom"));
    await expect(recoverInterruptedRuns(runAnalysis, execute)).resolves.toEqual({ requeued: 0, dispatched: 2 });
    expect(runAnalysis).toHaveBeenCalledTimes(2);
  });

  it("does nothing when there is nothing to recover", async () => {
    execute
      .mockResolvedValueOnce([{ affectedRows: 0 }])
      .mockResolvedValueOnce([[]]);
    await expect(recoverInterruptedRuns(runAnalysis, execute)).resolves.toEqual({ requeued: 0, dispatched: 0 });
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});
