import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseLlmUsage, recordLlmCallReceipt } from "../lib/billing/cost-receipt";
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
    // 1M 输入 × 2 + 0.1M 输出 × 8 + 0.2M 缓存 × 0.5 = 2 + 0.8 + 0.1 = 2.9 元
    expect(params[17]).toBeCloseTo(2.9, 6);
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
