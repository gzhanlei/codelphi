import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TRIGGER_HOUR, resolvePushTriggerAction, runAnalysisTriggerSweepOnce, type TriggerSweepDependencies } from "../lib/analysis-trigger";
import type { Execute } from "../lib/db";

describe("resolvePushTriggerAction", () => {
  const base = { pendingPushCount: 0, hasSucceededAnalysis: true, triggerN: null };

  it("always dispatches immediately for push mode", () => {
    expect(resolvePushTriggerAction({ ...base, mode: "push" })).toBe("immediate");
  });

  it("defers daily-mode pushes to the sweep regardless of pending count", () => {
    expect(resolvePushTriggerAction({ ...base, mode: "daily", pendingPushCount: 99 })).toBe("defer");
  });

  it("defers push_count pushes below the threshold and triggers at it", () => {
    expect(resolvePushTriggerAction({ ...base, mode: "push_count", pendingPushCount: 3, triggerN: 5 })).toBe("defer");
    expect(resolvePushTriggerAction({ ...base, mode: "push_count", pendingPushCount: 4, triggerN: 5 })).toBe("immediate");
  });

  it("falls back to the default threshold (5) when triggerN is null", () => {
    expect(resolvePushTriggerAction({ ...base, mode: "push_count", pendingPushCount: 3, triggerN: null })).toBe("defer");
    expect(resolvePushTriggerAction({ ...base, mode: "push_count", pendingPushCount: 4, triggerN: null })).toBe("immediate");
  });

  it("makes the first analysis immediate for every mode (接入即见规格)", () => {
    for (const mode of ["push", "daily", "push_count"] as const) {
      expect(resolvePushTriggerAction({ ...base, mode, hasSucceededAnalysis: false, pendingPushCount: 0 })).toBe("immediate");
    }
  });
});

describe("runAnalysisTriggerSweepOnce", () => {
  const repoRow = { repositoryId: 9, provider: "github", owner: "gzhanlei", name: "codelphi", defaultBranch: "main", connectionId: 3, organizationId: 7 };

  function sweepHarness(options: { lastSha: string | null; head: string | null; failRepositoryId?: number | null; repos?: unknown[] }) {
    const executed: Array<{ sql: string; params: unknown[] }> = [];
    const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
      executed.push({ sql, params });
      if (sql.includes("FROM repositories r JOIN products")) return [options.repos ?? [repoRow]];
      if (sql.includes("FROM analysis_runs WHERE repository_id")) return [[{ afterSha: options.lastSha }]];
      if (sql.includes("UPDATE repositories SET pending_push_count")) return [{ affectedRows: 1 }];
      return [[], []];
    }) as unknown as Execute;
    const queue = vi.fn(async (repositoryId: number) => {
      if (options.failRepositoryId !== null && options.failRepositoryId !== undefined && repositoryId === options.failRepositoryId) throw new Error("quota_exceeded");
      return 100;
    });
    const getAdapter = vi.fn(() => ({
      getRepository: async () => ({ defaultBranch: "main" }),
      getBranchHead: async () => options.head,
    }));
    return { executed, queue, deps: { execute, queue, getAdapter } };
  }

  it("queues a cumulative analysis with before=last succeeded sha and resets pending", async () => {
    const { executed, queue, deps } = sweepHarness({ lastSha: "sha-base", head: "sha-head" });
    const outcome = await runAnalysisTriggerSweepOnce(deps as unknown as TriggerSweepDependencies);
    expect(outcome.analyzed).toBe(1);
    expect(outcome.errors).toEqual([]);
    expect(queue).toHaveBeenCalledWith(9, "sha-base", "sha-head", "push");
    expect(executed.some(({ sql, params }) => sql.includes("pending_push_count = 0") && params[0] === 9)).toBe(true);
    // 小时过滤与默认凌晨 3 点钉在 SQL 里（小时作为参数传入）
    expect(executed[0].sql).toContain("HOUR(CURRENT_TIMESTAMP) = COALESCE(r.analysis_trigger_hour, ?)");
    expect(executed[0].params[0]).toBe(DEFAULT_TRIGGER_HOUR);
    expect(DEFAULT_TRIGGER_HOUR).toBe(3);
  });

  it("skips repos with no new commits and still clears the pending counter", async () => {
    const { executed, queue, deps } = sweepHarness({ lastSha: "sha-head", head: "sha-head" });
    const outcome = await runAnalysisTriggerSweepOnce(deps as unknown as TriggerSweepDependencies);
    expect(outcome.noCommits).toBe(1);
    expect(queue).not.toHaveBeenCalled();
    expect(executed.some(({ sql }) => sql.includes("pending_push_count = 0"))).toBe(true);
  });

  it("keeps pending and continues with other repos when queueing fails (quota gate)", async () => {
    const failing = { ...repoRow, repositoryId: 9 };
    const healthy = { ...repoRow, repositoryId: 10 };
    const { executed, queue, deps } = sweepHarness({ lastSha: "sha-base", head: "sha-head", failRepositoryId: 9, repos: [failing, healthy] });
    const outcome = await runAnalysisTriggerSweepOnce(deps as unknown as TriggerSweepDependencies);
    expect(outcome.analyzed).toBe(1);
    expect(outcome.deferredSkip).toBe(1);
    expect(outcome.errors[0]).toContain("quota_exceeded");
    // 失败仓库的 pending 不归零（9 的归零 UPDATE 不存在），健康仓库正常归零（10）
    expect(executed.some(({ sql, params }) => sql.includes("pending_push_count = 0") && params[0] === 9)).toBe(false);
    expect(executed.some(({ sql, params }) => sql.includes("pending_push_count = 0") && params[0] === 10)).toBe(true);
    expect(queue).toHaveBeenCalledTimes(2);
  });
});
