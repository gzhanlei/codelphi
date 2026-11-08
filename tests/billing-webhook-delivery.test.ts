import { beforeEach, describe, expect, it, vi } from "vitest";
import { processGitHubWebhook } from "../lib/github-webhook";
import { BillingError } from "../lib/billing/core";
import type { EnqueueInTransactionInput } from "../lib/github-webhook";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const PAYLOAD = JSON.stringify({ ref: "refs/heads/main", before: "before", after: "after-sha", repository: { full_name: "gzhanlei/codelphi" } });

/** 内存版 github_webhook_deliveries / skipped_pushes：模拟真实 SQL 状态机语义。 */
function deliveryHarness() {
  interface Row {
    delivery_id: string;
    status: string;
    run_id: number | null;
    result_json: string | null;
  }
  const deliveries = new Map<string, Row>();
  const skipped: Array<{ repository_id: number; sha: string; reason: string; delivery_id: string }> = [];
  const conns: Array<{ commit: ReturnType<typeof vi.fn>; rollback: ReturnType<typeof vi.fn> }> = [];
  const db = {
    execute: vi.fn(),
    getConnection: vi.fn(async () => {
      const conn = {
        execute: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes("INSERT IGNORE INTO github_webhook_deliveries")) {
            const id = String(params[0]);
            if (!deliveries.has(id)) deliveries.set(id, { delivery_id: id, status: "received", run_id: null, result_json: null });
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("FROM github_webhook_deliveries WHERE delivery_id = ? FOR UPDATE")) {
            const row = deliveries.get(String(params[0]));
            return [row ? [row] : [], []];
          }
          if (sql.includes("UPDATE github_webhook_deliveries SET status")) {
            // status 恒为 SQL 字面量；delivery_id 恒为最后参数
            const row = deliveries.get(String(params.at(-1)));
            const literal = sql.match(/SET status = '([a-z_]+)'/);
            if (row && literal) {
              row.status = literal[1];
              if (sql.includes("run_id = ?")) {
                row.run_id = Number(params[0]);
                row.result_json = String(params[1]);
              } else if (sql.includes("result_json = ?")) {
                row.result_json = String(params[0]);
              }
            }
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("INSERT INTO skipped_pushes")) {
            skipped.push({ repository_id: Number(params[0]), sha: String(params[1]), reason: String(params[2]), delivery_id: String(params[3]) });
            return [{}];
          }
          return [[], []];
        }),
        beginTransaction: vi.fn(async () => undefined),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        release: vi.fn(),
      };
      conns.push(conn);
      return conn;
    }),
  };
  return {
    deliveries,
    skipped,
    conns,
    db,
    row(id: string) {
      return deliveries.get(id)!;
    },
  };
}

function baseDependencies(
  enqueue: (input: EnqueueInTransactionInput) => Promise<{ runId: number; reused: boolean }> & { mock?: unknown },
  queue = vi.fn(async () => 42),
) {
  return {
    verify: vi.fn(() => true),
    findRepository: vi.fn(async () => ({ id: 9, defaultBranch: "main" })),
    queue,
    enqueue,
  };
}

const pushInput = (deliveryId: string | null) => ({
  rawBody: PAYLOAD,
  event: "push",
  signature: "sig",
  secret: "secret",
  deliveryId,
});

beforeEach(() => {
  vi.mocked(getDb).mockReset();
});

describe("staged push delivery (contract P0-4)", () => {
  it("runs stage one then stage two atomically: received → processing → queued with the run reserved", async () => {
    const h = deliveryHarness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const enqueue = vi.fn(async () => ({ runId: 66, reused: false }));
    const result = await processGitHubWebhook(pushInput("D1"), baseDependencies(enqueue));
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: true, runId: 66 });
    const row = h.row("D1");
    expect(row.status).toBe("queued");
    expect(row.run_id).toBe(66);
    expect(JSON.parse(row.result_json!)).toEqual({ accepted: true, runId: 66 });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // 阶段二的 requestId 绑定投递身份（同 delivery 重投天然收敛到同请求）
    expect((enqueue.mock.calls[0] as unknown as [EnqueueInTransactionInput] | undefined)?.[0]?.requestId).toBe("push-D1");
    expect(h.skipped).toHaveLength(0);
  });

  it("returns the original result idempotently when the delivery is already queued", async () => {
    const h = deliveryHarness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    h.deliveries.set("D2", { delivery_id: "D2", status: "queued", run_id: 42, result_json: JSON.stringify({ accepted: true, runId: 42 }) });
    const enqueue = vi.fn(async () => ({ runId: 99, reused: false }));
    const result = await processGitHubWebhook(pushInput("D2"), baseDependencies(enqueue));
    expect(result.body).toEqual({ accepted: true, runId: 42 });
    if ("runId" in result) expect(result.runId).toBe(42);
  });

  it("records a skipped push and answers 202 when the billing gate refuses (quota / trial interception)", async () => {
    const h = deliveryHarness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const enqueue = vi.fn(async () => {
      // gate 钩子契约：拒绝抛 BillingError（webhook 据此区分 skipped 与 retryable）
      throw new BillingError("quota_exceeded", "no SAU left");
    });
    const result = await processGitHubWebhook(pushInput("D3"), baseDependencies(enqueue));
    expect(result.status).toBe(202);
    expect(result.body).toEqual({ accepted: false, skipped: true, reason: "quota_exceeded" });
    const row = h.row("D3");
    expect(row.status).toBe("skipped");
    expect(h.skipped).toEqual([{ repository_id: 9, sha: "after-sha", reason: "quota_exceeded", delivery_id: "D3" }]);
  });

  it("marks retryable failures and answers 500 so GitHub re-delivers; the retry continues processing (P0-4)", async () => {
    const h = deliveryHarness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const enqueue = vi.fn()
      .mockImplementationOnce(async () => {
        throw new Error("network unreachable");
      })
      .mockImplementationOnce(async () => ({ runId: 70, reused: false }));
    const first = await processGitHubWebhook(pushInput("D4"), baseDependencies(enqueue));
    expect(first.status).toBe(500);
    expect(first.body).toEqual({ error: "delivery_retryable" });
    expect(h.row("D4").status).toBe("failed_retryable");

    const second = await processGitHubWebhook(pushInput("D4"), baseDependencies(enqueue));
    expect(second.status).toBe(202);
    expect(h.row("D4").status).toBe("queued");
    expect(h.row("D4").run_id).toBe(70);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("continues processing a delivery left in received after a stage-two crash", async () => {
    const h = deliveryHarness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    // 模拟阶段一提交后、阶段二开始前进程崩溃：只存在 received 行
    h.deliveries.set("D5", { delivery_id: "D5", status: "received", run_id: null, result_json: null });
    const enqueue = vi.fn(async () => ({ runId: 71, reused: false }));
    const result = await processGitHubWebhook(pushInput("D5"), baseDependencies(enqueue));
    expect(result.status).toBe(202);
    expect(h.row("D5").status).toBe("queued");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("falls back to direct enqueue when no delivery identity is present (tests/scripts path)", async () => {
    const h = deliveryHarness();
    vi.mocked(getDb).mockReturnValue(h.db as never);
    const queue = vi.fn(async () => 42);
    const result = await processGitHubWebhook(pushInput(null), baseDependencies(vi.fn(), queue));
    expect(result.body).toEqual({ accepted: true, runId: 42 });
    expect(queue).toHaveBeenCalledWith(9, "before", "after-sha");
    expect(h.deliveries.size).toBe(0);
  });
});
