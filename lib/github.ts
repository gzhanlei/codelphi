import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { resolveGitHubToken, type GitHubAccess } from "./github-access";
import { normalizeChangeContext, numberedSourceContent, selectSourceCandidates } from "./github-source";

export interface GitHubRepository {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

const repositorySchema = z.object({ default_branch: z.string().min(1) });
const branchSchema = z.object({ commit: z.object({ sha: z.string().min(1) }) });

async function githubHeaders(access: GitHubAccess) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${await resolveGitHubToken(access)}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "radar-chandler",
  };
}

async function githubFetch(path: string, access: GitHubAccess = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: await githubHeaders(access),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json() as Promise<unknown>;
}

export function parseRepository(fullName: string): GitHubRepository {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY must use owner/name format");
  return { owner, name, defaultBranch: "main" };
}

export async function getRepository(repo: GitHubRepository, access: GitHubAccess = {}): Promise<GitHubRepository> {
  const data = repositorySchema.parse(await githubFetch(`/repos/${repo.owner}/${repo.name}`, access));
  return { ...repo, defaultBranch: data.default_branch };
}

export async function getChangeContext(repo: GitHubRepository, before: string | null, after: string, access: GitHubAccess = {}) {
  const isInitial = !before || /^0+$/.test(before);
  const path = isInitial
    ? `/repos/${repo.owner}/${repo.name}/commits/${after}`
    : `/repos/${repo.owner}/${repo.name}/compare/${before}...${after}`;
  const fallbackUrl = `https://github.com/${repo.owner}/${repo.name}/commit/${after}`;
  return normalizeChangeContext(await githubFetch(path, access), after, fallbackUrl);
}

async function fetchSourceFile(repo: GitHubRepository, sha: string, path: string, maxLength: number, access: GitHubAccess): Promise<SourceFile | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const data = await githubFetch(`/repos/${repo.owner}/${repo.name}/contents/${encodedPath}?ref=${sha}`, access);
  const content = numberedSourceContent(data, maxLength);
  return content ? { path, content } : null;
}

export async function getSourceSnapshot(repo: GitHubRepository, sha: string, access: GitHubAccess = {}): Promise<SourceFile[]> {
  const tree = await githubFetch(`/repos/${repo.owner}/${repo.name}/git/trees/${sha}?recursive=1`, access);
  const candidates = selectSourceCandidates(tree);
  let remaining = 160_000;
  const sources: SourceFile[] = [];

  for (const candidate of candidates) {
    if (remaining < 2_000) break;
    const source = await fetchSourceFile(repo, sha, candidate.path, Math.min(8_000, remaining), access);
    if (!source) continue;
    sources.push(source);
    remaining -= source.content.length;
  }
  return sources;
}

export async function getBranchHead(repo: GitHubRepository, access: GitHubAccess = {}) {
  const data = branchSchema.parse(await githubFetch(`/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.defaultBranch)}`, access));
  return data.commit.sha;
}

export function verifyGitHubSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
