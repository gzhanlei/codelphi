import { describe, expect, it, vi } from "vitest";
import { listGitHubRepositories } from "../lib/github-repositories";

const access = { connectionId: 9, organizationId: 7 };

function page(count: number) {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, full_name: `owner/repo-${index + 1}`, default_branch: index === 0 ? "main" : null, private: index % 2 === 0 }));
}

describe("GitHub installation repository listing", () => {
  it("returns accessible repositories and hasMore for a full page", async () => {
    const resolveToken = vi.fn(async () => "installation-token");
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ total_count: 101, repositories: page(100) }));
    const result = await listGitHubRepositories(access, 1, { resolveToken, fetcher });
    expect(resolveToken).toHaveBeenCalledWith(access);
    expect(result.repositories).toHaveLength(100);
    expect(result.repositories[0]).toEqual({ id: 1, fullName: "owner/repo-1", defaultBranch: "main", private: true });
    expect(result.repositories[1].defaultBranch).toBe("");
    expect(result.hasMore).toBe(true);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.github.com/installation/repositories?per_page=100&page=1");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer installation-token" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("marks a partial page as complete", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ total_count: 1, repositories: page(1) }));
    const result = await listGitHubRepositories(access, 2, { resolveToken: async () => "token", fetcher });
    expect(result.hasMore).toBe(false);
    expect(fetcher.mock.calls[0][0]).toContain("page=2");
  });

  it("defaults to page one and rejects non-positive, fractional and excessive pages", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ repositories: page(1) }));
    await listGitHubRepositories(access, undefined, { resolveToken: async () => "token", fetcher });
    expect(fetcher.mock.calls[0][0]).toContain("page=1");
    const lastPage = await listGitHubRepositories(access, 5, { resolveToken: async () => "token", fetcher });
    expect(lastPage.repositories).toHaveLength(1);
    for (const invalidPage of [0, -1, 1.5, 6]) {
      await expect(listGitHubRepositories(access, invalidPage, { resolveToken: async () => "token", fetcher })).rejects.toThrow("页码无效");
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns actionable permission errors without exposing response bodies", async () => {
    await expect(listGitHubRepositories(access, 1, { resolveToken: async () => "secret", fetcher: async () => new Response("sensitive body", { status: 403 }) })).rejects.toThrow("无权读取仓库列表");
    await expect(listGitHubRepositories(access, 1, { resolveToken: async () => "secret", fetcher: async () => new Response("missing", { status: 404 }) })).rejects.toThrow("安装不存在或已断开");
    await expect(listGitHubRepositories(access, 1, { resolveToken: async () => "secret", fetcher: async () => new Response("rate limited", { status: 429 }) })).rejects.toThrow("GitHub API 429");
  });
});
