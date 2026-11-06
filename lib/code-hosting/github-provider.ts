import { getBranchHead, getChangeContext, getPullRequestFiles, getRepository, listIssueComments, parseRepository, upsertIssueComment } from "../github";
import { createGitHubSourceBackend } from "../remote-source-index/github-backend";
import { listGitHubRepositories } from "../github-repositories";
import type { CodeHostingAdapter } from "./adapter";

function registrationError(error: unknown, access: Parameters<CodeHostingAdapter["getRepository"]>[1]) {
  if (!(error instanceof Error) || !error.message.startsWith("GitHub API 404")) return null;
  const guidance = access.connectionId
    ? "GitHub App 尚未授权该仓库。请先在 GitHub 安装 radar-product-observer 并选择该仓库，或改用服务器 Token。"
    : "仓库不存在，或服务器 Token 无权访问该仓库。";
  return new Error(`${guidance}（${error.message}）`);
}

export const githubCodeHostingAdapter: CodeHostingAdapter = {
  provider: "github",
  parseRepository,
  getRepository,
  getBranchHead,
  listRepositories: (access, page) => listGitHubRepositories(access, page),
  getChangeContext,
  createSourceBackend: (access) => createGitHubSourceBackend({ access }),
  repositoryUrl: (repository) => `https://github.com/${repository.owner}/${repository.name}`,
  getPullRequestFiles,
  listIssueComments,
  upsertIssueComment,
  explainRegistrationError: registrationError,
};
