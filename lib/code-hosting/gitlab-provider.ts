import { getGitlabBranchHead, getGitlabChangeContext, getGitlabRepository, gitlabRepositoryUrl, listGitlabRepositories, parseGitlabRepository } from "../gitlab";
import { createGitlabSourceBackend } from "../remote-source-index/gitlab-backend";
import type { CodeHostingAdapter } from "./adapter";

/**
 * C2 多 provider 接入层：GitLab 适配器（docs/specsight-gap-improvement-plan.md §6.2）。
 * 与 github-provider 同构；产品粒度与规格份数不变（一产品一主仓库一条版本链）。
 * PR 预演 / check run 属 GitHub 专有能力，GitLab 侧暂不实现（不注册可选方法）。
 */
export const gitlabCodeHostingAdapter: CodeHostingAdapter = {
  provider: "gitlab",
  parseRepository: parseGitlabRepository,
  getRepository: getGitlabRepository,
  getBranchHead: getGitlabBranchHead,
  listRepositories: (access, page) => listGitlabRepositories(access, page),
  getChangeContext: getGitlabChangeContext,
  createSourceBackend: (access) => createGitlabSourceBackend({ access }),
  repositoryUrl: (repository) => gitlabRepositoryUrl(repository),
};
