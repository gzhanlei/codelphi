import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAttemptLlmUsage, parseLlmUsage, recordLlmCallReceipt } from "../lib/billing/cost-receipt";
import { requestStructuredCompletion } from "../lib/ai";
import { getDb } from "../lib/db";

vi.mock("../lib/db", () => ({ getDb: vi.fn() }));

const execute = vi.fn();

beforeEach(() => {
  execute.mockReset();
  vi.unstubAllEnvs();
  vi.mocked(getDb).mockReturnValue({ execute } as never);
});

describe("llm usage parsing", () => {
  it("marks missing usage as unknown", () => {
    expect(parseLlmUsage(null)).toMatchObject({ usageStatus: "unknown", inputTokens: null, usageJson: null });
    expect(parseLlmUsage(undefined)).toMatchObject({ usageStatus: "unknown" });
  });

  it("parses OpenAI-style usage with cached token details", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } };
    expect(parseLlmUsage(usage)).toMatchObject({
      usageStatus: "known",
      inputTokens: 100,
      outputTokens: 20,
      cacheHitTokens: 40,
      cacheMissTokens: null,
      usageJson: JSON.stringify(usage),
    });
  });

  it("parses DeepSeek-style cache hit/miss fields", () => {
    const usage = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 };
    expect(parseLlmUsage(usage)).toMatchObject({ usageStatus: "known", cacheHitTokens: 60, cacheMissTokens: 40 });
  });

  it("keeps unrecognized usage payloads as known with raw json and null tokens", () => {
    const usage = { weird_field: 1 };
    const parsed = parseLlmUsage(usage);
    expect(parsed.usageStatus).toBe("known");
    expect(parsed.inputTokens).toBeNull();
    expect(parsed.usageJson).toBe(JSON.stringify(usage));
  });
});

describe("llm call receipt persistence", () => {
  it("writes a priced receipt with unit price snapshot and computed cost", async () => {
    vi.stubEnv("LLM_PRICES", JSON.stringify({ "deepseek-v4": { input: 2, output: 8, cache: 0.5, currency: "CNY", version: "cal-2026q4" } }));
    await recordLlmCallReceipt({
      runId: 8,
      accountId: 7,
      chargeComponent: "main",
      model: "deepseek-v4",
      outcome: "success",
      usageRaw: { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 200_000 } },
      providerRequestId: "chatcmpl-1",
    });
    expect(execute).toHaveBeenCalledOnce();
    const [sql, params] = execute.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO llm_call_receipts");
    expect(params).toMatchObject({
      0: 8,
      1: 7,
      2: "main",
      3: "deepseek-v4",
      4: "chatcmpl-1",
      5: "success",
      6: "known",
      12: "cal-2026q4",
      18: "priced",
    });
    // DeepSeek 语义：缓存命中按 cache 价替代 input 价——未命中 0.8M × 2 + 输出 0.1M × 8 + 命中 0.2M × 0.5 = 1.6 + 0.8 + 0.1 = 2.5 元
    expect(params[17]).toBeCloseTo(2.5, 6);
  });

  it("writes unknown-usage receipts with null cost for failed and timeout calls", async () => {
    vi.stubEnv("LLM_PRICES", JSON.stringify({ "deepseek-v4": { input: 2, output: 8 } }));
    for (const outcome of ["failed", "timeout"] as const) {
      execute.mockClear();
      await recordLlmCallReceipt({ runId: 8, accountId: null, chargeComponent: "main", model: "deepseek-v4", outcome, usageRaw: null });
      const [, params] = execute.mock.calls[0];
      expect(params[5]).toBe(outcome);
      expect(params[6]).toBe("unknown");
      expect(params[17]).toBeNull();
      expect(params[18]).toBe("priced");
    }
  });

  it("marks unpriced models instead of recording zero cost", async () => {
    await recordLlmCallReceipt({ runId: 8, accountId: 7, chargeComponent: "main", model: "unknown-model", outcome: "success", usageRaw: { prompt_tokens: 10, completion_tokens: 5 } });
    const [, params] = execute.mock.calls[0];
    expect(params[18]).toBe("unpriced");
    expect(params[17]).toBeNull();
    expect(params[12]).toBeNull();
  });

  it("never throws when the database write fails", async () => {
    execute.mockRejectedValue(new Error("connection lost"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(recordLlmCallReceipt({ runId: 8, accountId: 7, chargeComponent: "main", model: "m", outcome: "success", usageRaw: null })).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("llm call receipt task/attempt identity", () => {
  const identity = { taskKey: "task-1", unitKey: "unit-1", attemptId: "attempt-1", callStage: "judge" as const };

  it("writes the four identity columns for inventory calls", async () => {
    await recordLlmCallReceipt({
      runId: 8,
      accountId: 7,
      chargeComponent: "main",
      model: "m",
      outcome: "success",
      usageRaw: null,
      ...identity,
    });
    const [sql, params] = execute.mock.calls[0];
    expect(String(sql)).toContain("task_key");
    expect(String(sql)).toContain("unit_key");
    expect(String(sql)).toContain("attempt_id");
    expect(String(sql)).toContain("call_stage");
    expect(params).toHaveLength(24);
    expect(params[19]).toBeNull(); // call_kind 保持原位
    expect(params[20]).toBe("task-1");
    expect(params[21]).toBe("unit-1");
    expect(params[22]).toBe("attempt-1");
    expect(params[23]).toBe("judge");
  });

  it("writes NULL identity columns for legacy partition / W0-8 calls without them", async () => {
    await recordLlmCallReceipt({ runId: 8, accountId: 7, chargeComponent: "main", model: "m", outcome: "success", usageRaw: null });
    const [, params] = execute.mock.calls[0];
    expect(params[20]).toBeNull();
    expect(params[21]).toBeNull();
    expect(params[22]).toBeNull();
    expect(params[23]).toBeNull();
  });
});

describe("requestStructuredCompletion receipt identity passthrough", () => {
  const billing = {
    runId: 8,
    accountId: 7,
    chargeComponent: "main" as const,
    taskKey: "task-1",
    unitKey: "unit-1",
    attemptId: "attempt-1",
    callStage: "describe" as const,
  };
  const messages = [{ role: "user", content: "ping" }];

  beforeEach(() => {
    vi.stubEnv("AI_MODEL", "deepseek-v4");
    vi.stubEnv("AI_API_KEY", "test-key");
  });

  it("attaches task/attempt identity to timeout receipts", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutError; }));
    try {
      await expect(requestStructuredCompletion(messages, billing)).rejects.toThrow("aborted");
      expect(execute).toHaveBeenCalledOnce();
      const [, params] = execute.mock.calls[0];
      expect(params[5]).toBe("timeout");
      expect(params[6]).toBe("unknown");
      expect(params[20]).toBe("task-1");
      expect(params[21]).toBe("unit-1");
      expect(params[22]).toBe("attempt-1");
      expect(params[23]).toBe("describe");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attaches task/attempt identity to failed receipts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as Response));
    try {
      await expect(requestStructuredCompletion(messages, billing)).rejects.toThrow("AI gateway 500");
      expect(execute).toHaveBeenCalledOnce();
      const [, params] = execute.mock.calls[0];
      expect(params[5]).toBe("failed");
      expect(params[20]).toBe("task-1");
      expect(params[21]).toBe("unit-1");
      expect(params[22]).toBe("attempt-1");
      expect(params[23]).toBe("describe");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attaches task/attempt identity to success receipts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "req-1", choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    }) as Response));
    try {
      await expect(requestStructuredCompletion(messages, billing)).resolves.toBe("{}");
      expect(execute).toHaveBeenCalledOnce();
      const [, params] = execute.mock.calls[0];
      expect(params[5]).toBe("success");
      expect(params[6]).toBe("known");
      expect(params[20]).toBe("task-1");
      expect(params[21]).toBe("unit-1");
      expect(params[22]).toBe("attempt-1");
      expect(params[23]).toBe("describe");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps legacy billing contexts writing NULL identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "{}" } }] }),
    }) as Response));
    try {
      await requestStructuredCompletion(messages, { runId: 8, accountId: null, chargeComponent: "main" });
      const [, params] = execute.mock.calls[0];
      expect(params[20]).toBeNull();
      expect(params[21]).toBeNull();
      expect(params[22]).toBeNull();
      expect(params[23]).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("loadAttemptLlmUsage", () => {
  it("aggregates known, priced receipts for the attempt", async () => {
    execute.mockResolvedValue([[
      { usage_status: "known", pricing_status: "priced", input_tokens: 100, output_tokens: 20, llm_cost_amount: "1.500000" },
      { usage_status: "known", pricing_status: "priced", input_tokens: 50, output_tokens: 10, llm_cost_amount: "0.500000" },
    ]]);
    const usage = await loadAttemptLlmUsage(8, "attempt-1");
    const [sql, params] = execute.mock.calls[0];
    expect(String(sql)).toContain("FROM llm_call_receipts");
    expect(params).toEqual([8, "attempt-1"]);
    expect(usage).toEqual({
      llmCalls: 2,
      usageStatus: "known",
      pricingStatus: "priced",
      inputTokens: 150,
      outputTokens: 30,
      costAmount: 2,
    });
  });

  it("reports unknown usage with null tokens and cost instead of zero", async () => {
    execute.mockResolvedValue([[
      { usage_status: "known", pricing_status: "priced", input_tokens: 100, output_tokens: 20, llm_cost_amount: "1.000000" },
      { usage_status: "unknown", pricing_status: "priced", input_tokens: null, output_tokens: null, llm_cost_amount: null },
    ]]);
    const usage = await loadAttemptLlmUsage(8, "attempt-1");
    expect(usage.usageStatus).toBe("unknown");
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.costAmount).toBeNull();
  });

  it("reports unpriced attempts with null cost but real tokens", async () => {
    execute.mockResolvedValue([[
      { usage_status: "known", pricing_status: "unpriced", input_tokens: 100, output_tokens: 20, llm_cost_amount: null },
    ]]);
    const usage = await loadAttemptLlmUsage(8, "attempt-1");
    expect(usage.pricingStatus).toBe("unpriced");
    expect(usage.costAmount).toBeNull();
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(20);
  });

  it("never treats missing receipts as zero cost", async () => {
    execute.mockResolvedValue([[]]);
    const usage = await loadAttemptLlmUsage(8, "attempt-missing");
    expect(usage.llmCalls).toBe(0);
    expect(usage.usageStatus).toBe("unknown");
    expect(usage.pricingStatus).toBe("unpriced");
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.costAmount).toBeNull();
  });
});
