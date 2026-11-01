import { describe, expect, it } from "vitest";
import { productInputSchema, slugifyProductName } from "../lib/product-input";

describe("product registration input", () => {
  it("creates URL-safe slugs for product names", () => {
    expect(slugifyProductName("SalesBuddy")).toBe("salesbuddy");
    expect(slugifyProductName("Easy Make PPT")).toBe("easy-make-ppt");
    expect(slugifyProductName("听风")).toBe("");
  });

  it("accepts a complete product and rejects invalid repositories", () => {
    const input = { name: "SalesBuddy", slug: "salesbuddy", description: "", repository: "gzhanlei/salesbuddy", defaultBranch: "main", analyze: true };
    expect(productInputSchema.parse(input).defaultBranch).toBe("main");
    expect(() => productInputSchema.parse({ ...input, repository: "https://github.com/gzhanlei/salesbuddy" })).toThrow();
    expect(() => productInputSchema.parse({ ...input, slug: "Sales Buddy" })).toThrow();
  });
});
