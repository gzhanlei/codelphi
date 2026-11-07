import type { NotificationChannelView } from "./notifications";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function parse<T extends { error?: string }>(response: Response, fallback: string): Promise<T> {
  const data = await response.json() as T;
  if (!response.ok) throw new Error(data.error ?? fallback);
  return data;
}

export async function listChannels(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/notifications`, { cache: "no-store" });
  const data = await parse<{ error?: string; channels?: NotificationChannelView[] }>(response, "加载通知渠道失败");
  return data.channels ?? [];
}

export async function saveChannel(slug: string, kind: "slack" | "webhook", target: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/notifications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, target }),
  });
  await parse(response, "保存通知渠道失败");
  return "saved" as const;
}

export async function toggleChannel(slug: string, id: number, enabled: boolean, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/notifications/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  await parse(response, "更新通知渠道失败");
  return "updated" as const;
}

export async function removeChannel(slug: string, id: number, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/notifications/${id}`, { method: "DELETE" });
  await parse(response, "删除通知渠道失败");
  return "deleted" as const;
}

export async function testChannel(slug: string, id: number, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/notifications/${id}`, { method: "POST" });
  await parse(response, "发送测试消息失败");
  return "sent" as const;
}
