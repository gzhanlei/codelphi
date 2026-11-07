import { z } from "zod";

export const repositoryProviderSchema = z.enum(["gitee", "gitlab", "gitea"]);
export type RepositoryProvider = z.infer<typeof repositoryProviderSchema>;

export const repositoryConnectionInputSchema = z.object({
  provider: repositoryProviderSchema,
  baseUrl: z.string().trim().max(1024, "服务地址过长").optional(),
  token: z.string().trim().min(1, "请输入访问令牌").max(4096, "访问令牌过长"),
});

export type RepositoryConnectionInput = z.infer<typeof repositoryConnectionInputSchema>;
export type VerifiedRepositoryAccount = { accountLogin: string; displayName: string };
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export class RepositoryConnectionError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RepositoryConnectionError";
  }
}

export function repositoryProviderLabel(provider: RepositoryProvider) {
  return { gitee: "Gitee", gitlab: "GitLab", gitea: "Gitea" }[provider];
}

function customBaseUrl(value: string | undefined) {
  if (!value) throw new RepositoryConnectionError("请输入自有 Git 服务的 HTTPS 地址", 400);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RepositoryConnectionError("服务地址无效，请输入完整 HTTPS 地址", 400);
  }
  if (url.protocol !== "https:") throw new RepositoryConnectionError("为保护访问令牌，自有 Git 服务必须使用 HTTPS", 400);
  if (url.username || url.password || url.search || url.hash) {
    throw new RepositoryConnectionError("服务地址不能包含账号、密码、查询参数或片段", 400);
  }
  assertAllowedRepositoryHost(url);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function assertAllowedRepositoryHost(url: URL) {
  const configured = (process.env.REPOSITORY_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/:443$/, ""))
    .filter(Boolean);
  const allowed = new Set(["gitlab.com", ...configured]);
  if (!allowed.has(url.host.toLowerCase())) {
    throw new RepositoryConnectionError("该主机和端口未加入 REPOSITORY_HOST_ALLOWLIST，请联系 CoDelphi 管理员配置", 400);
  }
}

export function normalizeRepositoryConnectionInput(raw: unknown): RepositoryConnectionInput & { baseUrl: string } {
  const input = repositoryConnectionInputSchema.parse(raw);
  return { ...input, baseUrl: input.provider === "gitee" ? "https://gitee.com" : customBaseUrl(input.baseUrl) };
}

function verificationRequest(input: RepositoryConnectionInput & { baseUrl: string }): { url: string; headers: Record<string, string> } {
  if (input.provider === "gitee") {
    const url = new URL("/api/v5/user", input.baseUrl);
    url.searchParams.set("access_token", input.token);
    return { url: url.toString(), headers: { Accept: "application/json" } };
  }
  if (input.provider === "gitlab") {
    return { url: `${input.baseUrl}/api/v4/user`, headers: { Accept: "application/json", "PRIVATE-TOKEN": input.token } };
  }
  return { url: `${input.baseUrl}/api/v1/user`, headers: { Accept: "application/json", Authorization: `token ${input.token}` } };
}

function responseError(status: number) {
  if (status === 401 || status === 403) {
    return new RepositoryConnectionError("令牌无效或权限不足，请检查令牌及授权范围", 400);
  }
  if (status === 404) {
    return new RepositoryConnectionError("未找到代码平台接口，请检查服务地址和平台类型", 400);
  }
  return new RepositoryConnectionError(`代码平台暂时不可用（HTTP ${status}），请稍后重试`, 502);
}

function readAccount(data: unknown, provider: RepositoryProvider): VerifiedRepositoryAccount {
  if (!data || typeof data !== "object") throw new RepositoryConnectionError("代码平台返回了无效的用户信息", 502);
  const record = data as Record<string, unknown>;
  const login = provider === "gitlab" ? record.username : record.login;
  if (typeof login !== "string" || !login.trim()) throw new RepositoryConnectionError("代码平台未返回有效的账号信息", 502);
  const displayName = typeof record.name === "string" && record.name.trim() ? record.name.trim() : login.trim();
  return { accountLogin: login.trim(), displayName };
}

export async function verifyRepositoryCredentials(raw: unknown, fetcher: Fetcher = fetch): Promise<VerifiedRepositoryAccount> {
  const input = normalizeRepositoryConnectionInput(raw);
  const request = verificationRequest(input);
  let response: Response;
  try {
    response = await fetcher(request.url, {
      headers: request.headers,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RepositoryConnectionError("无法连接代码平台，请检查服务地址、网络和 TLS 证书", 502);
  }
  if (!response.ok) throw responseError(response.status);
  try {
    return readAccount(await response.json(), input.provider);
  } catch (error) {
    if (error instanceof RepositoryConnectionError) throw error;
    throw new RepositoryConnectionError("代码平台返回了无法解析的响应", 502);
  }
}
