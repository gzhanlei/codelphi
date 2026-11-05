import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateProductDescription } from "../lib/product-description";
import { descriptionUpdateSchema } from "../lib/product-input";

const execute = vi.fn();
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));

describe("product description update", () => {
  beforeEach(() => execute.mockReset());

  it("writes the manual description, clears generated evidence, and scopes by workspace", async () => {
    execute.mockResolvedValueOnce([[{ id: 3 }]]);
    await expect(updateProductDescription("salesbuddy", 7, "销售助手")).resolves.toEqual({ id: 3, description: "销售助手" });
    expect(execute).toHaveBeenNthCalledWith(1, "SELECT id FROM products WHERE slug = ? AND organization_id = ?", ["salesbuddy", 7]);
    expect(execute).toHaveBeenNthCalledWith(2, "UPDATE products SET description = ?, description_source = 'manual', description_evidence = NULL WHERE id = ?", ["销售助手", 3]);
  });

  it("returns null when the product is missing in the workspace", async () => {
    execute.mockResolvedValueOnce([[]]);
    await expect(updateProductDescription("missing", 7, "概况")).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("description update input", () => {
  it("accepts any text within the length limit and rejects longer or non-string values", () => {
    expect(descriptionUpdateSchema.parse({ description: "" })).toEqual({ description: "" });
    expect(descriptionUpdateSchema.parse({ description: "销售助手" })).toEqual({ description: "销售助手" });
    expect(() => descriptionUpdateSchema.parse({ description: "x".repeat(1001) })).toThrow("产品简介不能超过 1000 字");
    expect(() => descriptionUpdateSchema.parse({})).toThrow();
    expect(() => descriptionUpdateSchema.parse(null)).toThrow();
  });
});
