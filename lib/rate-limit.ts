import { createHmac } from "node:crypto";
import type { PoolConnection } from "mysql2/promise";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb } from "./db";

/**
 * 导出限流（契约 M1-T5/§10.4）：MySQL 固定窗口，行锁串行化 + 锁内绝对值写入（P1-5：
 * 不依赖 ODKU 求值顺序，预检与分配同锁段同权威值）。键 = HMAC-SHA256(服务端密钥, "kind:identity")，
 * 不落原始 IP/userId（P1-5：裸 SHA-256 可被低熵反查）；限流器故障 fail-open（保护措施不阻断业务），告警可见。
 */

export interface ExportRateLimits {
  /** 匿名（按 IP）每窗口次数 */
  anonymous: number;
  /** 登录（按 user）每窗口次数 */
  user: number;
  /** 窗口宽度秒，默认 1 小时 */
  windowSeconds?: number;
}

export function clientIpFrom(headers: Headers): string {
  const trusted = Number(process.env.TRUSTED_PROXY_COUNT ?? 1);
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((part) => part.trim()).filter(Boolean);
    // 只信我方反代链追加的部分：从右数第 N 跳（N = TRUSTED_PROXY_COUNT），不无条件信任客户端头
    const index = parts.length - trusted;
    if (index >= 0) return parts[index];
  }
  return headers.get("x-real-ip") ?? "unknown";
}

function rateLimitKey(kind: "ip" | "user", identity: string): string {
  return createHmac("sha256", process.env.RATE_LIMIT_KEY_SECRET ?? "").update(`${kind}:${identity}`).digest("hex");
}

/**
 * 消费一次导出配额。返回 allowed=false 时附带 Retry-After 秒数（窗口剩余）。
 * 行锁 + 锁内计算：同一 key 的并发消费被 FOR UPDATE 串行化，绝不超发。
 */
export async function consumeRateLimit(opts: { kind: "ip" | "user"; identity: string; limit: number; windowSeconds: number }): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  if (!process.env.RATE_LIMIT_KEY_SECRET?.trim()) {
    console.warn("[billing] RATE_LIMIT_KEY_SECRET is not configured; export rate limiting is disabled");
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const key = rateLimitKey(opts.kind, opts.identity);
  const windowMs = opts.windowSeconds * 1_000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1_000));

  let conn: PoolConnection | null = null;
  try {
    conn = await getDb().getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT count, window_start AS windowStart FROM rate_limit_hits WHERE rl_key = ? FOR UPDATE`,
      [key],
    );
    const row = (rows as Array<{ count: number; windowStart: string | Date }>)[0];
    const rowStart = row ? new Date(row.windowStart).getTime() : -1;
    const current = row && rowStart === windowStart.getTime() ? Number(row.count) : 0;
    if (current + 1 > opts.limit) {
      await conn.commit(); // 无写入，仅释放行锁
      conn.release();
      return { allowed: false, retryAfterSeconds };
    }
    const next = current + 1;
    await conn.execute(
      `INSERT INTO rate_limit_hits (rl_key, window_start, count) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE count = IF(window_start = VALUES(window_start), VALUES(count), 1), window_start = VALUES(window_start)`,
      [key, windowStart, next],
    );
    await conn.commit();
    conn.release();
    return { allowed: true, retryAfterSeconds: 0 };
  } catch (error) {
    // fail-open：限流器不可用时放行（导出为 0 价成本），告警进每日对账视野
    if (conn) {
      try {
        await conn.rollback();
      } catch {
        /* 连接可能未建立事务 */
      }
      conn.release();
    }
    console.error("[billing] rate limiter failed open", error);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** 导出路由统一入口：登录按 user、匿名按 IP（可信代理解析）；拒绝返回 429 + Retry-After，放行返回 null。 */
export async function enforceExportRateLimit(request: NextRequest, userSub: string | null, limits: ExportRateLimits): Promise<NextResponse | null> {
  const windowSeconds = limits.windowSeconds ?? 3_600;
  const identity: { kind: "ip" | "user"; id: string; limit: number } = userSub
    ? { kind: "user", id: userSub, limit: limits.user }
    : { kind: "ip", id: clientIpFrom(request.headers), limit: limits.anonymous };
  const outcome = await consumeRateLimit({ kind: identity.kind, identity: identity.id, limit: identity.limit, windowSeconds });
  if (outcome.allowed) return null;
  return NextResponse.json(
    { error: "rate_limited", message: "导出过于频繁，请稍后再试" },
    { status: 429, headers: { "Retry-After": String(outcome.retryAfterSeconds) } },
  );
}
