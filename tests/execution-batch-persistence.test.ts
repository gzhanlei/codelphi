import { beforeEach, describe, expect, it, vi } from "vitest";
import { withBatchTransaction } from "../lib/execution-batch/persistence";

const dbHolder = vi.hoisted(() => ({ getDbImpl: null as unknown as () => unknown }));
vi.mock("../lib/db", () => ({ getDb: () => dbHolder.getDbImpl() }));

function createConnection() {
  const calls: string[] = [];
  const executedStatements: string[] = [];
  const connection = {
    failCommit: false,
    beginTransaction: async () => {
      calls.push("begin");
    },
    execute: async (statement: string) => {
      executedStatements.push(statement);
      return [[]];
    },
    commit: async () => {
      if (connection.failCommit) throw new Error("commit failed");
      calls.push("commit");
    },
    rollback: async () => {
      calls.push("rollback");
    },
    release: () => {
      calls.push("release");
    },
  };
  return { calls, executedStatements, connection };
}

describe("withBatchTransaction (ub-mode coverage)", () => {
  let fixture: ReturnType<typeof createConnection>;

  beforeEach(() => {
    fixture = createConnection();
    dbHolder.getDbImpl = () => ({ getConnection: async () => fixture.connection });
  });

  it("commits and releases on success with the connection-bound execute", async () => {
    const outcome = await withBatchTransaction(async (execute) => {
      await execute("INSERT INTO analysis_behavior_batch_attempt_members ...", [1]);
      return "done" as const;
    });
    expect(outcome).toBe("done");
    expect(fixture.calls).toEqual(["begin", "commit", "release"]);
    expect(fixture.executedStatements).toHaveLength(1);
  });

  it("rolls back and releases when the work throws, preserving the original error", async () => {
    await expect(
      withBatchTransaction(async (execute) => {
        await execute("INSERT INTO analysis_behavior_batch_attempt_members ...", [1]);
        throw new Error("member insert failed");
      }),
    ).rejects.toThrow("member insert failed");
    expect(fixture.calls).toEqual(["begin", "rollback", "release"]);
  });

  it("rolls back when the commit itself fails", async () => {
    fixture.connection.failCommit = true;
    await expect(
      withBatchTransaction(async (execute) => {
        await execute("INSERT INTO analysis_behavior_batch_attempt_members ...", [1]);
      }),
    ).rejects.toThrow("commit failed");
    expect(fixture.calls).toEqual(["begin", "rollback", "release"]);
  });
});
