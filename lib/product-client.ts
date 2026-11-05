import type { z } from "zod";
import type { productInputSchema } from "./product-input";

type ProductInput = z.infer<typeof productInputSchema>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function productResponse<T extends { error?: string }>(response: Response, fallback: string) {
  const data = await response.json() as T;
  if (!response.ok) throw new Error(data.error ?? fallback);
  return data;
}

export async function createProduct(input: ProductInput, fetcher: Fetcher = fetch) {
  const response = await fetcher("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await productResponse<{ slug?: string; error?: string }>(response, "添加产品失败");
  if (!data.slug) throw new Error(data.error ?? "添加产品失败");
  return data.slug;
}

export async function deleteProduct(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}`, { method: "DELETE" });
  const data = await productResponse<{ status?: string; error?: string }>(response, "移除产品失败");
  if (data.status !== "deleted") throw new Error(data.error ?? "移除产品失败");
  return "deleted" as const;
}

export async function updateDescription(slug: string, description: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const data = await productResponse<{ status?: string; error?: string }>(response, "保存产品概况失败");
  if (data.status !== "updated") throw new Error(data.error ?? "保存产品概况失败");
  return "updated" as const;
}

export async function requestAnalysis(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/analyze`, { method: "POST" });
  const data = await productResponse<{ runId?: number; error?: string }>(response, "分析请求失败");
  return data.runId;
}
