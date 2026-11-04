import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GitHubRepositoryPicker, RepositoryFilter, RepositoryLoadMore, RepositorySelect } from "../components/github-repository-picker";
import { fetchGitHubRepositories } from "../lib/integration-client";
import {
  applyWhenActive,
  applyUnlessAborted,
  filterRepositories,
  initialRepositoryPage,
  loadInitialRepositories,
  mergeRepositories,
  repositoryChoices,
  runNextRepositories,
  selectRepository,
} from "../lib/repository-picker";

const repositories = [
  { id: 1, fullName: "Owner/Radar", defaultBranch: "main", private: true },
  { id: 2, fullName: "owner/shop", defaultBranch: "develop", private: false },
];

describe("repository picker state", () => {
  it("deduplicates, filters and preserves a manual repository", () => {
    const merged = mergeRepositories(repositories, [{ ...repositories[0], defaultBranch: "main" }]);
    expect(merged).toHaveLength(2);
    expect(filterRepositories(merged, "OWNER/rad")).toEqual([repositories[0]]);
    expect(filterRepositories(merged, " shop ")).toEqual([repositories[1]]);
    expect(filterRepositories(merged, "")).toEqual(merged);
    expect(initialRepositoryPage()).toBe(1);
    expect(repositoryChoices(merged, "manual/repo")[0]).toEqual({ id: 0, fullName: "manual/repo", defaultBranch: "", private: false });
    expect(repositoryChoices(merged, "Owner/Radar")).toEqual(merged);
  });

  it("selects a repository and only fills a known default branch", () => {
    const onRepositoryChange = vi.fn();
    const onBranchChange = vi.fn();
    selectRepository(repositories, "", onRepositoryChange, onBranchChange);
    expect(onRepositoryChange).not.toHaveBeenCalled();
    selectRepository(repositories, "Owner/Radar", onRepositoryChange, onBranchChange);
    expect(onRepositoryChange).toHaveBeenCalledWith("Owner/Radar");
    expect(onBranchChange).toHaveBeenCalledWith("main");
    selectRepository(repositories, "manual/repo", onRepositoryChange, onBranchChange);
    expect(onBranchChange).toHaveBeenCalledOnce();
  });

  it("loads the first page only for an installation and ignores stale updates", async () => {
    const fetcher = vi.fn(async () => ({ repositories, hasMore: false }));
    const empty = await loadInitialRepositories(null, new AbortController().signal, fetcher);
    expect(empty).toEqual({ repositories: [], hasMore: false });
    expect(fetcher).not.toHaveBeenCalled();
    await loadInitialRepositories(9, new AbortController().signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith(9, 1, expect.any(AbortSignal));
    const update = vi.fn();
    applyWhenActive(false, update);
    applyWhenActive(true, update);
    expect(update).toHaveBeenCalledOnce();
    const controller = new AbortController();
    controller.abort();
    applyUnlessAborted(controller.signal, update);
    expect(update).toHaveBeenCalledOnce();
  });

  it("does not start a concurrent next-page request", async () => {
    const controls = { setPending: vi.fn(), setError: vi.fn(), apply: vi.fn() };
    const fetcher = vi.fn(async () => ({ repositories, hasMore: false }));
    await runNextRepositories({ connectionId: 9, page: 1, pending: true, signal: new AbortController().signal }, repositories, controls, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(controls.setPending).not.toHaveBeenCalled();
  });

  it("appends the next page and resets pending", async () => {
    const controls = { setPending: vi.fn(), setError: vi.fn(), apply: vi.fn() };
    const fetcher = vi.fn(async () => ({ repositories: [repositories[1]], hasMore: true }));
    const controller = new AbortController();
    await runNextRepositories({ connectionId: 9, page: 1, pending: false, signal: controller.signal }, repositories, controls, fetcher);
    expect(fetcher).toHaveBeenCalledWith(9, 2, controller.signal);
    expect(controls.apply).toHaveBeenCalledWith(repositories, 2, true);
    expect(controls.setPending.mock.calls).toEqual([[true], [false]]);
  });

  it("surfaces next-page errors and always resets pending", async () => {
    const controls = { setPending: vi.fn(), setError: vi.fn(), apply: vi.fn() };
    await runNextRepositories({ connectionId: 9, page: 1, pending: false, signal: new AbortController().signal }, repositories, controls, async () => { throw new Error("denied"); });
    expect(controls.setError).toHaveBeenCalledWith("denied");
    expect(controls.setPending).toHaveBeenLastCalledWith(false);
  });

  it("does not merge an old connection page after its request is aborted", async () => {
    const controller = new AbortController();
    const controls = { setPending: vi.fn(), setError: vi.fn(), apply: vi.fn() };
    let finish!: (value: { repositories: typeof repositories; hasMore: boolean }) => void;
    const fetcher = vi.fn(() => new Promise<{ repositories: typeof repositories; hasMore: boolean }>((resolve) => { finish = resolve; }));
    const loading = runNextRepositories({ connectionId: 9, page: 1, pending: false, signal: controller.signal }, repositories, controls, fetcher);
    controller.abort();
    finish({ repositories, hasMore: false });
    await loading;
    expect(controls.apply).not.toHaveBeenCalled();
    expect(controls.setError.mock.calls).toEqual([[""]]);
    expect(controls.setPending.mock.calls).toEqual([[true]]);
  });
});

describe("repository picker presentation", () => {
  it("loads one page through the scoped endpoint and surfaces errors", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ repositories, hasMore: true }));
    const result = await fetchGitHubRepositories(9, 2, undefined, fetcher);
    expect(result.hasMore).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe("/api/repositories?provider=github&connectionId=9&page=2");
    await expect(fetchGitHubRepositories(9, 1, undefined, async () => Response.json({ error: "denied" }, { status: 403 }))).rejects.toThrow("denied");
    await expect(fetchGitHubRepositories(9, 1, undefined, async () => Response.json({ error: "" }, { status: 403 }))).rejects.toThrow("仓库列表读取失败");
  });

  it("renders loading, ready, private and public repository states", () => {
    const loading = renderToStaticMarkup(createElement(RepositorySelect, { choices: [], count: 0, repository: "", pending: true, onSelect: vi.fn() }));
    expect(loading).toContain("正在读取 GitHub 仓库");
    const ready = renderToStaticMarkup(createElement(RepositorySelect, { choices: repositories, count: 2, repository: "Owner/Radar", pending: false, onSelect: vi.fn() }));
    expect(ready).toContain("Owner/Radar · 私有");
    expect(ready).toContain("owner/shop");
    expect(ready).toContain("下方手动输入");
    const refreshing = renderToStaticMarkup(createElement(RepositorySelect, { choices: repositories, count: 2, repository: "Owner/Radar", pending: true, onSelect: vi.fn() }));
    expect(refreshing).toContain("请选择仓库");
    expect(refreshing).not.toContain("disabled");
  });

  it("renders filtering and pagination only when useful", () => {
    expect(renderToStaticMarkup(createElement(RepositoryFilter, { count: 11, value: "radar", onChange: vi.fn() }))).toContain("筛选仓库");
    expect(renderToStaticMarkup(createElement(RepositoryFilter, { count: 10, value: "", onChange: vi.fn() }))).toBe("");
    expect(renderToStaticMarkup(createElement(RepositoryFilter, { count: 2, value: "", onChange: vi.fn() }))).toBe("");
    expect(renderToStaticMarkup(createElement(RepositoryLoadMore, { hasMore: true, page: 1, pending: true, onLoad: vi.fn() }))).toContain("读取中");
    expect(renderToStaticMarkup(createElement(RepositoryLoadMore, { hasMore: true, page: 5, pending: false, onLoad: vi.fn() }))).toContain("前 500 个仓库");
    expect(renderToStaticMarkup(createElement(RepositoryLoadMore, { hasMore: false, page: 1, pending: false, onLoad: vi.fn() }))).toBe("");
  });

  it("renders the connected picker and hides it for the shared token fallback", () => {
    const html = renderToStaticMarkup(createElement(GitHubRepositoryPicker, { connectionId: 9, repository: "", onRepositoryChange: vi.fn(), onBranchChange: vi.fn() }));
    expect(html).toContain("从 GitHub 选择");
    expect(html).not.toContain("repository-load-more");
    expect(renderToStaticMarkup(createElement(GitHubRepositoryPicker, { connectionId: null, repository: "", onRepositoryChange: vi.fn(), onBranchChange: vi.fn() }))).toBe("");
  });
});
