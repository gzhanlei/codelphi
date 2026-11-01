type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function connectionAction(id: number, action: "check" | "disconnect", fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/integrations/github/connections/${id}/${action}`, { method: "POST" });
  const data = await response.json() as { status?: string; error?: string };
  if (!response.ok && !data.error) throw new Error("操作失败");
  return data;
}
