/** 账务常量（契约 §8）：默认值出自冻结契约 v1.5，M2 校准后允许调优（不属语义变更）。 */

function positiveNumber(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 预留 TTL：契约 §6.1/§6.3；M2 按 P99 分析时长校准。 */
export const RESERVATION_TTL_MINUTES = positiveNumber("BILLING_RESERVATION_TTL_MINUTES", 30);

/** 心跳间隔：分析执行中每周期续期一次预留（契约 §6.3）。 */
export const HEARTBEAT_INTERVAL_MS = positiveNumber("BILLING_HEARTBEAT_INTERVAL_SECONDS", 60) * 1_000;

/** sweep 判心跳过期阈值：连续 N 个周期未续期才视为悬挂。 */
export const HEARTBEAT_FRESH_WINDOW_MINUTES = positiveNumber("BILLING_HEARTBEAT_FRESH_WINDOW_MINUTES", 5);

/** M1-T6 预留清理扫描周期：预留清理不能等支付 sweep 的 10 分钟粒度。 */
export const SWEEP_RESERVATION_INTERVAL_MS = positiveNumber("BILLING_SWEEP_RESERVATION_INTERVAL_SECONDS", 60) * 1_000;

/** 死锁有限重试次数（契约 §6：锁序一致 + 幂等重试安全，不宣称排除死锁）。 */
export const DEADLOCK_RETRIES = positiveNumber("BILLING_DEADLOCK_RETRIES", 3);

/** 首发标准分析 SAU：单模型单调用，预估 = 实际恒等（契约 §6.1 差额结算契约）。 */
export const FIRST_RUN_UNITS = 1;
