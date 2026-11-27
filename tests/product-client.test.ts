import { describe, expect, it, vi } from "vitest";
import { createProduct, renameProduct, requestAnalysis, setAnalysisExecutor, setOutputLanguage, updateDescription } from "../lib/product-client";
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
    await expect(createProduct(input, async () => new Response(JSON.stringify({ error: "" }), { status: 201 }))).rejects.toMatchObject({ message: "" });
  });
});

describe("analysis client", () => {
  it("returns a queued run id and surfaces failures", async () => {
    await expect(requestAnalysis("radar", async () => new Response(JSON.stringify({ runId: 7 }), { status: 202 }))).resolves.toBe(7);
    await expect(requestAnalysis("radar", async () => new Response(JSON.stringify({ error: "无权限" }), { status: 403 }))).rejects.toThrow("无权限");
    await expect(requestAnalysis("radar", async () => new Response(JSON.stringify({ error: "" }), { status: 403 }))).rejects.toThrow("");
  });
});

describe("rename client", () => {
  it("patches name/slug and returns the current slug for navigation", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "updated", slug: "codelphi", organizationSlug: "default" }), { status: 200 }));
    await expect(renameProduct("radar", { name: "CoDelphi", slug: "codelphi" }, fetcher)).resolves.toEqual({ slug: "codelphi", organizationSlug: "default" });
    expect(fetcher).toHaveBeenCalledWith("/api/products/radar", expect.objectContaining({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "CoDelphi", slug: "codelphi" }),
    }));
    await expect(renameProduct("radar", { name: "CoDelphi" }, async () => new Response(JSON.stringify({ error: "该 Slug 已被同工作区其他产品使用" }), { status: 409 }))).rejects.toThrow("该 Slug 已被同工作区其他产品使用");
    await expect(renameProduct("radar", { name: "CoDelphi" }, async () => new Response(JSON.stringify({ status: "updated", slug: "codelphi" }), { status: 200 }))).rejects.toThrow("保存产品信息失败");
  });
});

describe("output language client", () => {
  it("patches how the product is analysed and brings back the server's reason when it refuses", async () => {
    const fetcher = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify({ status: "updated" }), { status: 200 }));
    await expect(setAnalysisExecutor("radar", "client", fetcher)).resolves.toBe("updated");
    expect(fetcher).toHaveBeenCalledWith("/api/products/radar", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ analysisExecutor: "client" }) }));
    // 工作区没配模型时服务端回 409，并且说要去哪里配：页面要显示的是这句话。
    await expect(setAnalysisExecutor("radar", "server", async () => new Response(JSON.stringify({ error: "model_not_configured", message: "这个产品由服务端分析，分析要用工作区自己的模型。" }), { status: 409 }))).rejects.toThrow(/^这个产品由服务端分析/);
    await expect(setAnalysisExecutor("radar", "server", async () => new Response(JSON.stringify({}), { status: 200 }))).rejects.toThrow("保存分析方式失败");
  });

  it("patches the product output language and surfaces failures", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "updated" }), { status: 200 }));
    await expect(setOutputLanguage("radar", "en", fetcher)).resolves.toBe("updated");
    expect(fetcher).toHaveBeenCalledWith("/api/products/radar", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ outputLanguage: "en" }),
    }));
    await expect(setOutputLanguage("radar", "en", async () => new Response(JSON.stringify({ error: "只有工作区成员可以修改公开演示设置" }), { status: 403 }))).rejects.toThrow("只有工作区成员可以修改公开演示设置");
  });
});

describe("description client", () => {
  it("patches the overview and surfaces failures", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: "updated" }), { status: 200 }));
    await expect(updateDescription("radar", "新概况", fetcher)).resolves.toBe("updated");
    expect(fetcher).toHaveBeenCalledWith("/api/products/radar", expect.objectContaining({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "新概况" }),
    }));
    await expect(updateDescription("radar", "新概况", async () => new Response(JSON.stringify({ error: "无权限" }), { status: 403 }))).rejects.toThrow("无权限");
    await expect(updateDescription("radar", "新概况", async () => new Response(JSON.stringify({}), { status: 200 }))).rejects.toThrow("保存产品概况失败");
  });
});
