import { describe, expect, it, vi } from "vitest";
import { isDeepSeekPeakHours, llmCostAmount, resolveLlmPricing } from "../lib/billing/llm-pricing";

// DeepSeek 官方高峰定义：UTC 周一至周五 01:00-04:00 与 06:00-10:00（= 北京 09:00-12:00、14:00-18:00）。
// 其余（周末/节假日/夜间）为错峰。节假日未内置日历——官方按错峰计价时需人工核对（见 docs/analysis-pipeline.md）。
const utc = (iso: string) => new Date(iso);

describe("isDeepSeekPeakHours", () => {
  it("flags weekday peak windows (UTC 01:00-04:00 and 06:00-10:00)", () => {
    expect(isDeepSeekPeakHours(utc("2026-11-09T01:30:00Z"))).toBe(true); // 周一 01:30
    expect(isDeepSeekPeakHours(utc("2026-11-09T03:59:00Z"))).toBe(true);
    expect(isDeepSeekPeakHours(utc("2026-11-09T06:00:00Z"))).toBe(true);
    expect(isDeepSeekPeakHours(utc("2026-11-09T09:59:00Z"))).toBe(true);
  });

  it("treats off-peak windows, weekends as non-peak", () => {
    expect(isDeepSeekPeakHours(utc("2026-11-09T04:00:00Z"))).toBe(false); // 04:00 整点 = 错峰
    expect(isDeepSeekPeakHours(utc("2026-11-09T05:00:00Z"))).toBe(false);
    expect(isDeepSeekPeakHours(utc("2026-11-09T23:00:00Z"))).toBe(false);
    expect(isDeepSeekPeakHours(utc("2026-11-07T02:00:00Z"))).toBe(false); // 周六
    expect(isDeepSeekPeakHours(utc("2026-11-08T08:00:00Z"))).toBe(false); // 周日
  });
});

describe("llm pricing resolution", () => {
  it("returns unpriced when LLM_PRICES is missing or blank", () => {
    expect(resolveLlmPricing("deepseek-v4", undefined)).toEqual({ status: "unpriced" });
    expect(resolveLlmPricing("deepseek-v4", "  ")).toEqual({ status: "unpriced" });
  });

  it("returns unpriced for malformed json or unknown models instead of guessing zero cost", () => {
    expect(resolveLlmPricing("deepseek-v4", "{not json")).toEqual({ status: "unpriced" });
    expect(resolveLlmPricing("deepseek-v4", JSON.stringify({ other: { input: 1, output: 1 } }))).toEqual({ status: "unpriced" });
  });

  it("rejects malformed price entries", () => {
    expect(resolveLlmPricing("m", JSON.stringify({ m: { input: "free" } }))).toEqual({ status: "unpriced" });
    expect(resolveLlmPricing("m", JSON.stringify({ m: { peak: { input: 1, output: 1 } } }))).toEqual({ status: "unpriced" });
  });

  it("resolves a flat-configured model with defaults", () => {
    expect(resolveLlmPricing("deepseek-v4", JSON.stringify({ "deepseek-v4": { input: 2, output: 8 } }))).toEqual({
      status: "priced",
      version: "v1",
      inputPrice: 2,
      outputPrice: 8,
      cachePrice: 0,
      currency: "CNY",
      period: "flat",
    });
  });

  const phased = JSON.stringify({
    "ds-flash": {
      peak: { input: 0.3, output: 1.2, cache: 0.006 },
      offPeak: { input: 0.15, output: 0.6, cache: 0.003 },
      currency: "USD",
      version: "deepseek-flash-2026-11",
    },
  });

  it("picks peak rates during weekday peak windows and stamps the period into the version", () => {
    const pricing = resolveLlmPricing("ds-flash", phased, utc("2026-11-09T02:00:00Z"));
    expect(pricing).toEqual({
      status: "priced",
      version: "deepseek-flash-2026-11:peak",
      inputPrice: 0.3,
      outputPrice: 1.2,
      cachePrice: 0.006,
      currency: "USD",
      period: "peak",
    });
  });

  it("picks off-peak rates outside peak windows and on weekends", () => {
    const noon = resolveLlmPricing("ds-flash", phased, utc("2026-11-09T12:00:00Z"));
    const weekend = resolveLlmPricing("ds-flash", phased, utc("2026-11-08T02:00:00Z"));
    expect(noon.status === "priced" && noon.period).toBe("offPeak");
    expect(weekend.status === "priced" && weekend.period).toBe("offPeak");
    expect(noon.status === "priced" && noon.inputPrice).toBe(0.15);
    expect(noon.status === "priced" && noon.cachePrice).toBe(0.003);
  });
});

describe("llm cost computation", () => {
  it("bills cache-hit tokens at cache price INSTEAD of input price (DeepSeek 语义)", () => {
    // 1M 输入中 200k 缓存命中：未命中 800k×2 + 命中 200k×0.5 + 输出 100k×8
    const pricing = { status: "priced" as const, version: "v1:peak", inputPrice: 2, outputPrice: 8, cachePrice: 0.5, currency: "CNY", period: "peak" as const };
    expect(llmCostAmount(pricing, { inputTokens: 1_000_000, outputTokens: 100_000, cacheHitTokens: 200_000 })).toBeCloseTo(2.5, 6);
  });

  it("treats cache hits larger than input defensively (miss floors at zero)", () => {
    const pricing = { status: "priced" as const, version: "v1:peak", inputPrice: 2, outputPrice: 8, cachePrice: 0.5, currency: "CNY", period: "peak" as const };
    expect(llmCostAmount(pricing, { inputTokens: 100_000, outputTokens: 0, cacheHitTokens: 200_000 })).toBeCloseTo((100_000 / 1e6) * 0.5, 6);
  });

  it("treats null usage components as zero, not as an error", () => {
    const pricing = { status: "priced" as const, version: "v1:flat", inputPrice: 2, outputPrice: 8, cachePrice: 0, currency: "CNY", period: "flat" as const };
    expect(llmCostAmount(pricing, { inputTokens: null, outputTokens: null, cacheHitTokens: null })).toBe(0);
  });

  it("returns null for unpriced models", () => {
    expect(llmCostAmount({ status: "unpriced" }, { inputTokens: 1, outputTokens: 1, cacheHitTokens: null })).toBeNull();
  });
});
