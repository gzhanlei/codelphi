import type { z } from "zod";
import type { productInputSchema } from "./product-input";

type ProductInput = z.infer<typeof productInputSchema>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function createProduct(input: ProductInput, fetcher: Fetcher = fetch) {
  const response = await fetcher("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await response.json() as { slug?: string; error?: string };
  if (!response.ok || !data.slug) throw new Error(data.error ?? "添加产品失败");
  return data.slug;
}

export async function requestAnalysis(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/analyze`, { method: "POST" });
  const data = await response.json() as { runId?: number; error?: string };
  if (!response.ok) throw new Error(data.error ?? "分析请求失败");
  return data.runId;
}
