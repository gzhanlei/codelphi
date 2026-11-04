import { z } from "zod";
import { resolveGitHubToken, type GitHubAccess } from "./github-access";

const responseSchema = z.object({
  repositories: z.array(z.object({
    id: z.number(),
    full_name: z.string().regex(/^[^/]+\/[^/]+$/),
    default_branch: z.string().nullable().optional(),
    private: z.boolean().default(false),
  })),
});

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type TokenResolver = (access: GitHubAccess) => Promise<string>;

interface ListOptions {
  resolveToken?: TokenResolver;
  fetcher?: Fetcher;
}

export class RepositoryListError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "RepositoryListError";
  }
}

function responseError(status: number) {
  if (status === 401 || status === 403) return new RepositoryListError("GitHub App 无权读取仓库列表，请检查安装权限", 400);
  if (status === 404) return new RepositoryListError("GitHub App 安装不存在或已断开", 400);
  return new RepositoryListError(`GitHub API ${status}`, 502);
}

export async function listGitHubRepositories(access: GitHubAccess, page = 1, options: ListOptions = {}) {
  if (!Number.isInteger(page) || page < 1 || page > 5) throw new RepositoryListError("仓库列表页码无效", 400);
  const { resolveToken = resolveGitHubToken, fetcher = fetch } = options;
  const token = await resolveToken(access);
  const response = await fetcher(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "radar-repository-picker",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw responseError(response.status);
  const data = responseSchema.parse(await response.json());
  return {
    repositories: data.repositories.map((repository) => ({
      id: repository.id,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch || "",
      private: repository.private,
    })),
    hasMore: data.repositories.length === 100,
  };
}
