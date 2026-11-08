import { describe, expect, it, vi } from "vitest";
import { llmCostAmount, resolveLlmPricing } from "../lib/billing/llm-pricing";

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
  });

  it("resolves a configured model with defaults", () => {
    expect(resolveLlmPricing("deepseek-v4", JSON.stringify({ "deepseek-v4": { input: 2, output: 8 } }))).toEqual({
      status: "priced",
      version: "v1",
      inputPrice: 2,
      outputPrice: 8,
      cachePrice: 0,
      currency: "CNY",
    });
  });
});

describe("llm cost computation", () => {
  it("computes cost from per-million token prices", () => {
    const pricing = { status: "priced" as const, version: "v1", inputPrice: 2, outputPrice: 8, cachePrice: 0.5, currency: "CNY" };
    expect(llmCostAmount(pricing, { inputTokens: 1_000_000, outputTokens: 100_000, cacheHitTokens: 200_000 })).toBeCloseTo(2.9, 6);
  });

  it("treats null usage components as zero, not as an error", () => {
    const pricing = { status: "priced" as const, version: "v1", inputPrice: 2, outputPrice: 8, cachePrice: 0, currency: "CNY" };
    expect(llmCostAmount(pricing, { inputTokens: null, outputTokens: null, cacheHitTokens: null })).toBe(0);
  });

  it("returns null for unpriced models", () => {
    expect(llmCostAmount({ status: "unpriced" }, { inputTokens: 1, outputTokens: 1, cacheHitTokens: null })).toBeNull();
  });
});
