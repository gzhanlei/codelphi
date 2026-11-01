import { describe, expect, it, vi } from "vitest";
import { createProduct, requestAnalysis } from "../lib/product-client";
import { productInputSchema } from "../lib/product-input";

const input = productInputSchema.parse({ name: "SalesBuddy", slug: "salesbuddy", description: "", repository: "gzhanlei/salesbuddy", defaultBranch: "", analyze: false });

describe("product creation client", () => {
  it("posts the form and returns the registered slug", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ slug: "salesbuddy", runId: null }), { status: 201 }));
    await expect(createProduct(input, fetcher)).resolves.toBe("salesbuddy");
    expect(fetcher).toHaveBeenCalledWith("/api/products", expect.objectContaining({ method: "POST" }));
  });

  it("uses the server error and rejects a missing success slug", async () => {
    await expect(createProduct(input, async () => new Response(JSON.stringify({ error: "已经注册" }), { status: 409 }))).rejects.toThrow("已经注册");
    await expect(createProduct(input, async () => new Response(JSON.stringify({}), { status: 201 }))).rejects.toThrow("添加产品失败");
    await expect(createProduct(input, async () => new Response(JSON.stringify({ error: "" }), { status: 409 }))).rejects.toThrow("");
  });
});

describe("analysis client", () => {
  it("returns a queued run id and surfaces failures", async () => {
    await expect(requestAnalysis("radar", async () => new Response(JSON.stringify({ runId: 7 }), { status: 202 }))).resolves.toBe(7);
    await expect(requestAnalysis("radar", async () => new Response(JSON.stringify({ error: "无权限" }), { status: 403 }))).rejects.toThrow("无权限");
    await expect(requestAnalysis("radar", async () => new Response(JSON.stringify({ error: "" }), { status: 403 }))).rejects.toThrow("");
  });
});
