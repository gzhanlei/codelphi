import { describe, expect, it, vi } from "vitest";
import { loadProductOutputLanguage, outputLanguageSchema, OUTPUT_LANGUAGE_LABELS } from "../lib/analysis-language";
import { productInputSchema, productUpdateSchema } from "../lib/product-input";

describe("product output language loader", () => {
  it("reads the product row and falls back to zh-CN", async () => {
    const execute = vi.fn(async () => [[{ outputLanguage: "en" }]] as never);
    await expect(loadProductOutputLanguage(4, execute as never)).resolves.toBe("en");
    const fallback = vi.fn(async () => [[]] as never);
    await expect(loadProductOutputLanguage(4, fallback as never)).resolves.toBe("zh-CN");
  });
});

describe("output language schema", () => {
  it("accepts supported languages and rejects others", () => {
    expect(outputLanguageSchema.parse("zh-CN")).toBe("zh-CN");
    expect(outputLanguageSchema.parse("en")).toBe("en");
    expect(() => outputLanguageSchema.parse("zh")).toThrow();
    expect(() => outputLanguageSchema.parse("en-US")).toThrow();
    expect(() => outputLanguageSchema.parse("中文")).toThrow();
  });

  it("labels every language for UI dropdowns", () => {
    expect(OUTPUT_LANGUAGE_LABELS["zh-CN"]).toBeTruthy();
    expect(OUTPUT_LANGUAGE_LABELS.en).toBeTruthy();
  });
});

describe("product input with output language", () => {
  const base = { name: "SalesBuddy", slug: "salesbuddy", description: "", repository: "gzhanlei/salesbuddy", defaultBranch: "main", analyze: true };

  it("accepts an explicit output language on registration", () => {
    expect(productInputSchema.parse({ ...base, outputLanguage: "en" }).outputLanguage).toBe("en");
    expect(productInputSchema.parse(base).outputLanguage).toBeUndefined();
  });

  it("rejects unsupported languages", () => {
    expect(() => productInputSchema.parse({ ...base, outputLanguage: "fr" })).toThrow();
  });

  it("allows updating only the output language", () => {
    expect(productUpdateSchema.parse({ outputLanguage: "en" }).outputLanguage).toBe("en");
    expect(() => productUpdateSchema.parse({ outputLanguage: "zh" })).toThrow();
  });
});
