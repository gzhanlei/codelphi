import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBillingSweeps } from "../lib/billing/sweep";

describe("billing sweep job registry", () => {
  // 调度器会注册真实的 setInterval：用假时钟兜住，不让定时器活过本文件、漏进同进程的其他测试。
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("registers the presentation refresh job alongside the other periodic jobs", () => {
    const started = startBillingSweeps();
    if (!started.started || !started.jobs) throw new Error("sweeps did not start");
    expect(started.jobs).toEqual(expect.arrayContaining(["presentation-refresh", "feedback-adjudication", "queued-run-recovery"]));
    // 幂等启动：重复调用不会重复注册
    expect(startBillingSweeps()).toEqual({ started: false });
    expect(started.jobs.filter((job) => job === "presentation-refresh")).toHaveLength(1);
  });
});
