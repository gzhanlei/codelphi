import { beforeEach, describe, expect, it, vi } from "vitest";
import { failOrphanedRuns, redispatchQueuedRuns } from "../lib/analysis-recovery";

const execute = vi.fn();
const runAnalysis = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startup analysis recovery", () => {
  it("marks every orphaned running run as failed with an explicit message", async () => {
    execute.mockResolvedValue([{ affectedRows: 2 }]);
    await expect(failOrphanedRuns(execute)).resolves.toBe(2);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("WHERE status = 'running'"),
      ["analysis interrupted by server restart (orphaned running run)"],
    );
  });

  it("returns zero when no run was orphaned", async () => {
    execute.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(failOrphanedRuns(execute)).resolves.toBe(0);
  });

  it("re-dispatches queued runs that lost their executor", async () => {
    execute.mockResolvedValue([[{ id: 51 }, { id: 57 }]]);
    await expect(redispatchQueuedRuns(runAnalysis, execute)).resolves.toBe(2);
    expect(runAnalysis).toHaveBeenCalledTimes(2);
    expect(runAnalysis).toHaveBeenCalledWith(51);
    expect(runAnalysis).toHaveBeenCalledWith(57);
  });

  it("keeps re-dispatching when one queued run fails immediately", async () => {
    execute.mockResolvedValue([[{ id: 51 }, { id: 57 }]]);
    runAnalysis.mockRejectedValueOnce(new Error("boom"));
    await expect(redispatchQueuedRuns(runAnalysis, execute)).resolves.toBe(2);
    expect(runAnalysis).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the queue is empty", async () => {
    execute.mockResolvedValue([[]]);
    await expect(redispatchQueuedRuns(runAnalysis, execute)).resolves.toBe(0);
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});
