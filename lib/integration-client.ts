type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

type RepositoryPageResult = { repositories: Array<{ id: number; fullName: string; defaultBranch: string; private: boolean }>; hasMore: boolean; error?: string };

type ConnectionResult = { status?: string; error?: string; accountLogin?: string };

async function readConnectionResponse(response: Response): Promise<ConnectionResult> {
  const data = await response.json() as ConnectionResult;
  if (!response.ok && !data.error) throw new Error("操作失败");
  return data;
}

export async function fetchGitHubRepositories(connectionId: number, page = 1, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<RepositoryPageResult> {
  const response = await fetcher(`/api/repositories?provider=github&connectionId=${connectionId}&page=${page}`, { signal, cache: "no-store" });
  const data = await response.json() as RepositoryPageResult;
  if (!response.ok) throw new Error(data.error || "仓库列表读取失败");
  return data;
}

export function connectionAction(id: number, action: "check" | "disconnect", fetcher: Fetcher = fetch) {
  return fetcher(`/api/integrations/github/connections/${id}/${action}`, { method: "POST" }).then(readConnectionResponse);
}

export function repositoryConnectionAction(id: number, action: "check", fetcher: Fetcher = fetch) {
  return fetcher(`/api/integrations/repositories/${id}/${action}`, { method: "POST" }).then(readConnectionResponse);
}

export async function deleteRepositoryConnection(id: number, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/integrations/repositories/${id}`, { method: "DELETE" });
  const data = await readConnectionResponse(response);
  if (!response.ok) throw new Error(data.error);
  return data;
}

export async function runConnectionAction(
  id: number,
  action: "check" | "disconnect" | "delete",
  kind: "github" | "repository",
  fetcher: Fetcher = fetch,
) {
  if (action === "delete") return deleteRepositoryConnection(id, fetcher);
  if (action === "disconnect") return connectionAction(id, action, fetcher);
  if (kind === "github") return connectionAction(id, action, fetcher);
  return repositoryConnectionAction(id, action, fetcher);
}

export async function saveRepositoryConnection(
  input: { provider: "gitee" | "gitlab" | "gitea"; baseUrl?: string; token: string },
  fetcher: Fetcher = fetch,
) {
  const response = await fetcher("/api/integrations/repositories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await readConnectionResponse(response);
  if (!response.ok || !data.accountLogin) throw new Error(data.error ?? "连接保存失败");
  return data as ConnectionResult & { accountLogin: string };
}
