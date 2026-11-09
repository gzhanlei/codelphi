import { timingSafeEqual } from "node:crypto";
import type { ChangeContext, ChangeFile, RepositoryAccess, RepositoryRef } from "./code-hosting/types";

/**
 * C2 多 provider 接入层：GitLab（docs/specsight-gap-improvement-plan.md §6.2）。
 * 范围只到接入层：不改「一产品 = 一主仓库 = 一条规格版本链」的产品粒度。
 * 验签差异：GitLab 用明文 secret token 头（X-Gitlab-Token）恒时比较，不是 GitHub 的 HMAC。
 */

export type GitlabRepository = RepositoryRef;

interface GitlabCommit { id: string; message: string; committed_date: string; web_url: string }
interface GitlabDiff { old_path: string; new_path: string; diff: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean }

export function gitlabApiBase() {
  return process.env.GITLAB_API_BASE ?? "https://gitlab.com/api/v4";
}

export function gitlabToken(access: RepositoryAccess = {}) {
  if (access.token) return access.token;
  const env = process.env.GITLAB_TOKEN;
  if (!env) throw new Error("GITLAB_TOKEN is not configured");
  return env;
}

export async function gitlabFetch(path: string, access: RepositoryAccess = {}, init: { method?: string; body?: string } = {}) {
  const response = await fetch(`${gitlabApiBase()}${path}`, {
    headers: {
      Accept: "application/json",
      "PRIVATE-TOKEN": gitlabToken(access),
      "User-Agent": "codelphi-chandler",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    ...init,
  });
  if (!response.ok) throw new Error(`GitLab API ${response.status}: ${await response.text()}`);
  return response.json() as Promise<unknown>;
}

/** GitLab 项目路径可含多级 namespace：owner 取首段，其余归入 name（URL 编码后即项目路径）。 */
export function parseGitlabRepository(fullName: string): GitlabRepository {
  const segments = fullName.split("/").filter(Boolean);
  if (segments.length < 2) throw new Error(`Invalid GitLab repository: ${fullName}`);
  return { owner: segments[0], name: segments.slice(1).join("/"), defaultBranch: "main" };
}

function projectPath(ref: GitlabRepository) {
  return encodeURIComponent(`${ref.owner}/${ref.name}`);
}

export async function getGitlabRepository(ref: GitlabRepository, access: RepositoryAccess = {}): Promise<GitlabRepository> {
  const data = await gitlabFetch(`/projects/${projectPath(ref)}`, access) as { default_branch?: string };
  return { ...ref, defaultBranch: data.default_branch ?? ref.defaultBranch };
}

export async function getGitlabBranchHead(ref: GitlabRepository, access: RepositoryAccess = {}): Promise<string> {
  const data = await gitlabFetch(`/projects/${projectPath(ref)}/repository/branches/${encodeURIComponent(ref.defaultBranch)}`, access) as { commit: { id: string } };
  return data.commit.id;
}

export async function getGitlabChangeContext(ref: GitlabRepository, before: string | null, after: string, access: RepositoryAccess = {}): Promise<ChangeContext> {
  if (!before) {
    // 首次接入：GitLab compare 无 from 可比，取最新一次提交
    const commits = await gitlabFetch(`/projects/${projectPath(ref)}/repository/commits?ref_name=${encodeURIComponent(ref.defaultBranch)}&per_page=1`, access) as GitlabCommit[];
    const commit = commits[0];
    if (!commit) throw new Error(`GitLab repository has no commits: ${ref.owner}/${ref.name}`);
    const diffs = await gitlabFetch(`/projects/${projectPath(ref)}/repository/commits/${encodeURIComponent(commit.id)}/diff`, access) as GitlabDiff[];
    return { message: commit.message.trim().split("\n")[0], committedAt: commit.committed_date, url: commit.web_url, files: diffs.map(mapDiff) };
  }
  const data = await gitlabFetch(`/projects/${projectPath(ref)}/repository/compare?from=${encodeURIComponent(before)}&to=${encodeURIComponent(after)}`, access) as { commits: GitlabCommit[]; diffs: GitlabDiff[] };
  const last = data.commits[data.commits.length - 1];
  if (!last) throw new Error(`GitLab compare returned no commits: ${before}..${after}`);
  return { message: last.message.trim().split("\n")[0], committedAt: last.committed_date, url: last.web_url, files: data.diffs.map(mapDiff) };
}

function mapDiff(diff: GitlabDiff): ChangeFile {
  const status = diff.new_file ? "added" : diff.deleted_file ? "removed" : diff.renamed_file ? "renamed" : "modified";
  return { path: diff.new_path, status, patch: diff.diff };
}

export function gitlabRepositoryUrl(ref: Pick<GitlabRepository, "owner" | "name">) {
  const host = (process.env.GITLAB_API_BASE ?? "https://gitlab.com/api/v4").replace(/\/api\/v4$/, "").replace(/^https?:\/\//, "");
  return `https://${host}/${ref.owner}/${ref.name}`;
}

export async function listGitlabRepositories(access: RepositoryAccess = {}, page: number) {
  const data = await gitlabFetch(`/projects?membership=true&simple=true&order_by=last_activity_at&per_page=20&page=${page}`, access) as Array<{
    id: number; path_with_namespace: string; default_branch?: string; visibility: string;
  }>;
  return {
    repositories: data.map((project) => ({
      id: project.id,
      fullName: project.path_with_namespace,
      defaultBranch: project.default_branch ?? "main",
      private: project.visibility !== "public",
    })),
    hasMore: data.length === 20,
  };
}

/** GitLab webhook 验签：明文 secret token 头恒时比较（与 GitHub 的 HMAC-SHA256 不同）。 */
export function verifyGitlabSignature(_rawBody: string, tokenHeader: string | null, secret: string) {
  if (!tokenHeader) return false;
  const a = Buffer.from(tokenHeader);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
