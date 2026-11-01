import type { z } from "zod";
import type { featureInputSchema, scenarioInputSchema } from "./spec-editor";

type FeatureInput = z.infer<typeof featureInputSchema>;
type ScenarioInput = z.infer<typeof scenarioInputSchema>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function request<T = unknown>(url: string, init: RequestInit, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, init);
  if (response.redirected) throw new Error("登录已过期，请重新登录");
  const contentType = response.headers.get("content-type");
  if (contentType && !contentType.includes("application/json")) {
    if (response.status === 401 || response.status === 403) throw new Error("登录已过期，请重新登录");
    throw new Error("服务返回了无效响应");
  }
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(data.error || "保存失败，请重试");
  return data as T;
}

export function featureIdFromParam(value?: string) {
  if (!value) return undefined;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export function featureEndpoint(slug: string, id?: number) {
  return id ? `/api/features/${id}` : `/api/products/${slug}/features`;
}

export async function saveFeature(slug: string, input: FeatureInput, id?: number, fetcher: Fetcher = fetch): Promise<{ id: number }> {
  return request(featureEndpoint(slug, id), {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, fetcher);
}

export async function deleteFeatureRequest(id: number, fetcher: Fetcher = fetch) {
  return request(`/api/features/${id}`, { method: "DELETE" }, fetcher);
}

function browserConfirm(message: string) {
  return window.confirm(message);
}

type Confirm = (message: string) => boolean;

export async function deleteConfirmedFeature(feature: { id: number; name: string } | undefined, confirm: Confirm = browserConfirm, fetcher: Fetcher = fetch) {
  if (!feature || !confirm(`确定删除功能「${feature.name}」及其场景吗？历史规格版本会保留。`)) return false;
  await deleteFeatureRequest(feature.id, fetcher);
  return true;
}

export async function saveScenario(featureId: number, input: ScenarioInput, id?: number, fetcher: Fetcher = fetch) {
  return request(id ? `/api/scenarios/${id}` : `/api/features/${featureId}/scenarios`, {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }, fetcher);
}

export async function deleteScenarioRequest(id: number, fetcher: Fetcher = fetch) {
  return request(`/api/scenarios/${id}`, { method: "DELETE" }, fetcher);
}

export async function deleteConfirmedScenario(scenario: { id: number; reference: string }, confirm: Confirm = browserConfirm, fetcher: Fetcher = fetch) {
  if (!confirm(`确定删除场景 ${scenario.reference} 吗？此操作会保留历史版本。`)) return false;
  await deleteScenarioRequest(scenario.id, fetcher);
  return true;
}
