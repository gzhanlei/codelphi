import { z } from "zod";
import type { PoolConnection } from "mysql2/promise";
import { queueAnalysis } from "./analysis";
import { getDb } from "./db";
import { verifyGitHubSignature } from "./github";
import { getLatestGitHubApp } from "./github-integrations";
import { requiredEnv } from "./env";
import { BillingError, enqueueRunWithReservationInTransaction } from "./billing/core";
import { enqueueBillingNotification } from "./billing/notifications";

const pushSchema = z.object({
  ref: z.string(),
  before: z.string(),
  after: z.string(),
  repository: z.object({ full_name: z.string().regex(/^[^/]+\/[^/]+$/, "full_name must be owner/name") }),
});

const pullRequestSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({ sha: z.string() }),
  }),
  repository: z.object({ full_name: z.string().regex(/^[^/]+\/[^/]+$/, "full_name must be owner/name") }),
});

export interface PrPreviewJob {
  repositoryId: number;
  number: number;
  sha: string;
  owner: string;
  name: string;
}

interface WebhookInput {
  rawBody: string;
  event: string | null;
  signature: string | null;
  secret: string | string[];
  /** GitHub X-GitHub-Delivery：两阶段幂等投递的身份；缺失时退回直接入队（测试/脚本路径）。 */
  deliveryId?: string | null;
}

interface RepositoryTarget {
  id: number;
  defaultBranch: string;
}

interface DeliveryRow {
  delivery_id: string;
  status: string;
  run_id: number | null;
  result_json: string | null;
}

export interface EnqueueInTransactionInput {
  conn: PoolConnection;
  repositoryId: number;
  requestId: string;
  trigger: "manual" | "push";
  beforeSha: string | null;
  afterSha: string;
}

interface WebhookDependencies {
  verify: (rawBody: string, signature: string | null, secret: string) => boolean;
  findRepository: (owner: string, name: string) => Promise<RepositoryTarget | undefined>;
  queue: (repositoryId: number, before: string, after: string) => Promise<number>;
  /** 阶段二：调用方事务内完成「run 创建 + 预留」（契约 P0-4 两阶段的原子段）。 */
  enqueue: (input: EnqueueInTransactionInput) => Promise<{ runId: number; reused: boolean }>;
}

async function findRepository(owner: string, name: string) {
  const [rows] = await getDb().execute("SELECT id, default_branch AS defaultBranch FROM repositories WHERE provider = 'github' AND owner = ? AND name = ? LIMIT 1", [owner, name]);
  return (rows as RepositoryTarget[])[0];
}

/** 自动 push 的 Trial 拦截（契约 §8.2.5）：trialing 账户的 push 触发分析一律 skipped、零费用。 */
async function trialPushGate(ctx: { account: { plan_status: string } }) {
  if (ctx.account.plan_status === "trialing") {
    throw new BillingError("billing_state_conflict", "trial_auto_push_blocked");
  }
}

const defaultDependencies: WebhookDependencies = {
  verify: verifyGitHubSignature,
  findRepository,
  queue: (repositoryId, before, after) => queueAnalysis(repositoryId, before, after, "push"),
  enqueue: (input) =>
    enqueueRunWithReservationInTransaction(
      input.conn,
      {
        repositoryId: input.repositoryId,
        requestId: input.requestId,
        trigger: input.trigger,
        beforeSha: input.beforeSha,
        afterSha: input.afterSha,
        gate: trialPushGate,
      },
    ),
};

export async function resolveGitHubWebhookSecrets(getApp: () => Promise<{ webhookSecret?: string } | null> = getLatestGitHubApp, env: Record<string, string | undefined> = process.env) {
  const app = await getApp();
  const candidates = [app?.webhookSecret, env.GITHUB_WEBHOOK_SECRET].filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim());
  const secrets = [...new Set(candidates)];
  return secrets.length > 0 ? secrets : [requiredEnv("GITHUB_WEBHOOK_SECRET")];
}

/** 阶段一（独立事务）：验证合法后持久化接收事实；唯一约束防重复接收，重复投递读回原行（契约 P0-4）。 */
export async function stageGitHubDelivery(deliveryId: string, eventType = "push") {
  const conn = await getDb().getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `INSERT IGNORE INTO github_webhook_deliveries (delivery_id, event_type, status) VALUES (?, ?, 'received')`,
      [deliveryId, eventType],
    );
    const [rows] = await conn.execute(
      `SELECT delivery_id, status, run_id, result_json FROM github_webhook_deliveries WHERE delivery_id = ? FOR UPDATE`,
      [deliveryId],
    );
    await conn.commit();
    conn.release();
    return (rows as DeliveryRow[])[0];
  } catch (error) {
    await conn.rollback();
    conn.release();
    throw error;
  }
}

/** 阶段二：行锁 + 状态机推进；queued/skipped 幂等返回原结果，received/processing/failed_retryable 续处理（P0-4）。 */
async function deliverStagedPush(
  input: { deliveryId: string; repositoryId: number; before: string; after: string },
  dependencies: WebhookDependencies,
): Promise<{ status: number; body: Record<string, unknown>; runId?: number }> {
  const conn = await getDb().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT delivery_id, status, run_id, result_json FROM github_webhook_deliveries WHERE delivery_id = ? FOR UPDATE`,
      [input.deliveryId],
    );
    const row = (rows as DeliveryRow[])[0];
    if (!row) {
      // 阶段一行丢失（理论不可能）：按可重试处理，让投递方重试
      throw new Error(`delivery ${input.deliveryId} staged row missing`);
    }
    if (row.status === "queued" || row.status === "skipped") {
      // 已终态：幂等返回原结果，绝不重复入队
      await conn.commit();
      conn.release();
      const body = row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : { accepted: true };
      return { status: 202, body, runId: row.run_id ?? undefined };
    }
    await conn.execute(`UPDATE github_webhook_deliveries SET status = 'processing' WHERE delivery_id = ?`, [input.deliveryId]);

    try {
      const result = await dependencies.enqueue({
        conn,
        repositoryId: input.repositoryId,
        requestId: `push-${input.deliveryId}`,
        trigger: "push",
        beforeSha: input.before,
        afterSha: input.after,
      });
      const body = { accepted: true, runId: result.runId };
      await conn.execute(
        `UPDATE github_webhook_deliveries SET status = 'queued', run_id = ?, result_json = ? WHERE delivery_id = ?`,
        [result.runId, JSON.stringify(body), input.deliveryId],
      );
      await conn.commit();
      conn.release();
      return { status: 202, body, runId: result.runId };
    } catch (error) {
      if (!(error instanceof BillingError)) throw error;
      // 闸门拒绝（额度/Trial 拦截/状态）→ skipped（§12.4.3）：静默跳过、零费用、不重试风暴
      const reason = error.code === "quota_exceeded" ? "quota_exceeded" : error.message.replace(/^\[[^\]]+\]\s*/, "").slice(0, 64);
      await conn.execute(
        `INSERT INTO skipped_pushes (repository_id, sha, reason, delivery_id) VALUES (?, ?, ?, ?)`,
        [input.repositoryId, input.after, reason.slice(0, 64), input.deliveryId],
      );
      const body = { accepted: false, skipped: true, reason };
      await conn.execute(
        `UPDATE github_webhook_deliveries SET status = 'skipped', result_json = ? WHERE delivery_id = ?`,
        [JSON.stringify(body), input.deliveryId],
      );
      await conn.commit();
      conn.release();
      console.warn("[billing] auto push skipped by gate", { deliveryId: input.deliveryId, repositoryId: input.repositoryId, reason });
      try {
        const [orgRows] = await conn.execute(
          `SELECT p.organization_id AS organizationId FROM repositories repo JOIN products p ON p.id = repo.product_id WHERE repo.id = ?`,
          [input.repositoryId],
        );
        const accountId = Number((orgRows as Array<{ organizationId: number }>)[0]?.organizationId ?? 0);
        if (accountId) {
          await enqueueBillingNotification({
            accountId,
            billingPeriod: "trial",
            type: "skipped_push",
            threshold: 0,
            subject: "[CoDelphi] 自动分析因额度跳过",
            body: `一次代码推送（${input.after.slice(0, 10)}）因额度不足被跳过，未产生费用。购买套餐后可在产品页「补分析最新提交」恢复同步。`,
          });
        }
      } catch (notifyError) {
        console.warn("[billing] skipped push notification enqueue failed", notifyError);
      }
      return { status: 202, body };
    }
  } catch (error) {
    try {
      await conn.rollback();
    } finally {
      conn.release();
    }
    // 可重试异常：独立事务标 failed_retryable，GitHub 重投按 received/failed_retryable 续处理
    try {
      const retryConn = await getDb().getConnection();
      try {
        await retryConn.beginTransaction();
        await retryConn.execute(
          `UPDATE github_webhook_deliveries SET status = 'failed_retryable' WHERE delivery_id = ? AND status = 'processing'`,
          [input.deliveryId],
        );
        await retryConn.commit();
      } finally {
        retryConn.release();
      }
    } catch (markError) {
      console.error("[billing] failed to mark delivery retryable", markError);
    }
    console.error("[billing] staged push delivery failed retryably", { deliveryId: input.deliveryId, error });
    return { status: 500, body: { error: "delivery_retryable" } };
  }
}

export async function processGitHubWebhook(input: WebhookInput, dependencies: WebhookDependencies = defaultDependencies) {
  const secrets = Array.isArray(input.secret) ? input.secret : [input.secret];
  const verified = secrets.some((secret) => dependencies.verify(input.rawBody, input.signature, secret));
  if (!verified) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  if (input.event === "ping") return { status: 200, body: { ok: true } };
  if (input.event === "pull_request") {
    const payload = pullRequestSchema.parse(JSON.parse(input.rawBody));
    if (payload.action !== "opened" && payload.action !== "synchronize") return { status: 202, body: { ignored: true } };
    const [owner, name] = payload.repository.full_name.split("/");
    const repository = await dependencies.findRepository(owner, name);
    if (!repository) return { status: 202, body: { ignored: true } };
    return {
      status: 202,
      body: { accepted: true },
      preview: { repositoryId: repository.id, number: payload.pull_request.number, sha: payload.pull_request.head.sha, owner, name },
    };
  }
  if (input.event !== "push") return { status: 202, body: { ignored: true } };

  const payload = pushSchema.parse(JSON.parse(input.rawBody));
  if (/^0+$/.test(payload.after)) return { status: 202, body: { ignored: "branch_deleted" } };
  const [owner, name] = payload.repository.full_name.split("/");
  const repository = await dependencies.findRepository(owner, name);
  if (!repository || payload.ref !== `refs/heads/${repository.defaultBranch}`) {
    return { status: 202, body: { ignored: "unregistered_repository_or_branch" } };
  }

  if (!input.deliveryId) {
    // 无投递身份（测试/脚本路径）：直接入队（闸门仍生效，BillingError 上抛）
    const runId = await dependencies.queue(repository.id, payload.before, payload.after);
    return { status: 202, body: { accepted: true, runId }, runId };
  }

  // 两阶段（契约 P0-4）：阶段一持久化接收事实（独立事务）；阶段二行锁下推进状态机
  await stageGitHubDelivery(input.deliveryId, "push");
  const delivered = await deliverStagedPush(
    { deliveryId: input.deliveryId, repositoryId: repository.id, before: payload.before, after: payload.after },
    dependencies,
  );
  return { ...delivered, body: delivered.body as Record<string, unknown> };
}
