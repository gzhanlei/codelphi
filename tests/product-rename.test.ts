import { beforeEach, describe, expect, it, vi } from "vitest";
import { findProductByOldSlug, updateProductIdentity } from "../lib/product-rename";
import { productUpdateSchema } from "../lib/product-input";

const execute = vi.fn();
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }) }));

describe("product rename", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue([[], []]);
  });

  it("renames the display name without touching the slug history", async () => {
    execute.mockResolvedValueOnce([[{ id: 3, name: "radar", slug: "radar" }]]);
    await expect(updateProductIdentity("radar", 7, { name: "CoDelphi" })).resolves.toEqual({ status: "updated", id: 3, name: "CoDelphi", slug: "radar" });
    expect(execute).toHaveBeenNthCalledWith(1, "SELECT id, name, slug FROM products WHERE slug = ? AND organization_id = ?", ["radar", 7]);
    expect(execute).toHaveBeenNthCalledWith(2, "UPDATE products SET name = COALESCE(?, name), slug = COALESCE(?, slug) WHERE id = ?", ["CoDelphi", null, 3]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("changes the slug, records the old one in history, and keeps redirect targets fresh", async () => {
    execute.mockResolvedValueOnce([[{ id: 3, name: "radar", slug: "radar" }]]);
    execute.mockResolvedValueOnce([[]]); // 同组织内无 slug 冲突
    await expect(updateProductIdentity("radar", 7, { newSlug: "codelphi" })).resolves.toEqual({ status: "updated", id: 3, name: "radar", slug: "codelphi" });
    expect(execute).toHaveBeenNthCalledWith(2, "SELECT id FROM products WHERE slug = ? AND organization_id = ? AND id != ?", ["codelphi", 7, 3]);
    expect(execute).toHaveBeenNthCalledWith(3, "UPDATE products SET name = COALESCE(?, name), slug = COALESCE(?, slug) WHERE id = ?", [null, "codelphi", 3]);
    expect(execute).toHaveBeenNthCalledWith(4, "DELETE FROM product_slug_history WHERE old_slug = ?", ["codelphi"]);
    expect(execute).toHaveBeenNthCalledWith(5, "INSERT INTO product_slug_history (product_id, old_slug) VALUES (?, ?) ON DUPLICATE KEY UPDATE product_id = VALUES(product_id), changed_at = CURRENT_TIMESTAMP(3)", [3, "radar"]);
  });

  it("rejects a slug already taken by another product in the same workspace", async () => {
    execute.mockResolvedValueOnce([[{ id: 3, name: "radar", slug: "radar" }]]);
    execute.mockResolvedValueOnce([[{ id: 9 }]]);
    await expect(updateProductIdentity("radar", 7, { newSlug: "salesbuddy" })).resolves.toEqual({ status: "slug_conflict" });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("maps a concurrent unique-key violation to a slug conflict", async () => {
    execute.mockResolvedValueOnce([[{ id: 3, name: "radar", slug: "radar" }]]);
    execute.mockResolvedValueOnce([[]]);
    execute.mockRejectedValueOnce(Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" }));
    await expect(updateProductIdentity("radar", 7, { newSlug: "codelphi" })).resolves.toEqual({ status: "slug_conflict" });
  });

  it("returns not_found when the product is missing in the workspace", async () => {
    execute.mockResolvedValueOnce([[]]);
    await expect(updateProductIdentity("missing", 7, { name: "CoDelphi" })).resolves.toEqual({ status: "not_found" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("resolves the current address of an old slug", async () => {
    execute.mockResolvedValueOnce([[{ slug: "codelphi" }]]);
    await expect(findProductByOldSlug("radar")).resolves.toEqual({ slug: "codelphi" });
    execute.mockResolvedValueOnce([[]]);
    await expect(findProductByOldSlug("unknown")).resolves.toBeNull();
  });
});

describe("product update input", () => {
  it("accepts name, slug, or description and requires at least one field", () => {
    expect(productUpdateSchema.parse({ name: "CoDelphi" })).toEqual({ name: "CoDelphi" });
    expect(productUpdateSchema.parse({ slug: " Codelphi " })).toEqual({ slug: "codelphi" });
    expect(productUpdateSchema.parse({ description: "概况" })).toEqual({ description: "概况" });
    expect(() => productUpdateSchema.parse({})).toThrow("请提供要修改的内容");
    expect(() => productUpdateSchema.parse({ slug: "Co Delphi!" })).toThrow("Slug 只能包含小写字母、数字和单个连字符");
    expect(() => productUpdateSchema.parse({ name: "" })).toThrow("请输入产品名称");
    expect(() => productUpdateSchema.parse({ name: "x".repeat(101) })).toThrow("产品名称过长");
  });
});
