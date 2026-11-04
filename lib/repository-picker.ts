import { fetchGitHubRepositories } from "./integration-client";
import type { RepositoryChoice, RepositoryPage } from "./code-hosting/types";
import { errorMessage } from "./error-message";

type RepositoryFetcher = (connectionId: number, page: number, signal?: AbortSignal) => Promise<RepositoryPage>;

export function initialRepositoryPage() {
  return 1;
}

export function mergeRepositories(current: RepositoryChoice[], incoming: RepositoryChoice[]) {
  return [...new Map([...current, ...incoming].map((repository) => [repository.fullName, repository])).values()];
}

export function filterRepositories(repositories: RepositoryChoice[], query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return repositories;
  return repositories.filter((repository) => repository.fullName.toLowerCase().includes(normalized));
}

export function repositoryChoices(repositories: RepositoryChoice[], repository: string) {
  if (!repository || repositories.some((item) => item.fullName === repository)) return repositories;
  return [{ id: 0, fullName: repository, defaultBranch: "", private: false }, ...repositories];
}

export function selectRepository(repositories: RepositoryChoice[], value: string, onRepositoryChange: (value: string) => void, onBranchChange: (value: string) => void) {
  if (!value) return;
  onRepositoryChange(value);
  const defaultBranch = repositories.find((item) => item.fullName === value)?.defaultBranch;
  if (defaultBranch) onBranchChange(defaultBranch);
}

export function applyWhenActive(active: boolean, update: () => void) {
  if (active) update();
}

export function applyUnlessAborted(signal: AbortSignal, update: () => void) {
  applyWhenActive(!signal.aborted, update);
}

export function loadInitialRepositories(connectionId: number | null, signal: AbortSignal, fetcher: RepositoryFetcher = fetchGitHubRepositories) {
  if (connectionId === null) return Promise.resolve({ repositories: [], hasMore: false });
  return fetcher(connectionId, 1, signal);
}

interface NextLoadControls {
  setPending: (pending: boolean) => void;
  setError: (message: string) => void;
  apply: (repositories: RepositoryChoice[], page: number, hasMore: boolean) => void;
}

export async function runNextRepositories(input: { connectionId: number | null; page: number; pending: boolean; signal: AbortSignal }, current: RepositoryChoice[], controls: NextLoadControls, fetcher: RepositoryFetcher = fetchGitHubRepositories) {
  if (input.connectionId === null || input.pending) return;
  controls.setPending(true);
  controls.setError("");
  try {
    const result = await fetcher(input.connectionId, input.page + 1, input.signal).then((page) => ({ ...page, page: input.page + 1 }));
    applyUnlessAborted(input.signal, () => controls.apply(mergeRepositories(current, result.repositories), result.page, result.hasMore));
  } catch (cause) {
    applyUnlessAborted(input.signal, () => controls.setError(errorMessage(cause, "更多仓库读取失败")));
  } finally {
    applyUnlessAborted(input.signal, () => controls.setPending(false));
  }
}
