import { createHmac, timingSafeEqual } from "node:crypto";
import { requiredEnv } from "./env";

export interface GitHubRepository {
  owner: string;
  name: string;
  defaultBranch: string;
}

export interface SourceFile {
  path: string;
  content: string;
}

function githubHeaders() {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${requiredEnv("GITHUB_TOKEN")}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "radar-chandler",
  };
}

async function githubFetch(path: string) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: githubHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.json();
}

export function parseRepository(fullName: string): GitHubRepository {
  const [owner, name] = fullName.split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY must use owner/name format");
  return { owner, name, defaultBranch: "main" };
}

export async function getRepository(repo: GitHubRepository): Promise<GitHubRepository> {
  const data = await githubFetch(`/repos/${repo.owner}/${repo.name}`) as { default_branch: string };
  return { ...repo, defaultBranch: data.default_branch };
}

export async function getChangeContext(repo: GitHubRepository, before: string | null, after: string) {
  const isInitial = !before || /^0+$/.test(before);
  const path = isInitial
    ? `/repos/${repo.owner}/${repo.name}/commits/${after}`
    : `/repos/${repo.owner}/${repo.name}/compare/${before}...${after}`;
  const data = await githubFetch(path) as {
    html_url: string;
    commit?: { message: string; committer?: { date?: string } };
    commits?: Array<{ sha: string; commit: { message: string; committer?: { date?: string } } }>;
    files?: Array<{ filename: string; status: string; patch?: string }>;
  };
  const lastCommit = data.commits?.at(-1);
  const message = lastCommit?.commit.message ?? data.commit?.message ?? `Release ${after.slice(0, 7)}`;
  const committedAt = lastCommit?.commit.committer?.date ?? data.commit?.committer?.date ?? new Date().toISOString();
  const files = (data.files ?? []).slice(0, 80).map((file) => ({
    path: file.filename,
    status: file.status,
    patch: (file.patch ?? "(binary or patch unavailable)").slice(0, 8_000),
  }));
  return {
    message,
    committedAt,
    url: data.html_url ?? `https://github.com/${repo.owner}/${repo.name}/commit/${after}`,
    files,
    totalCharacters: JSON.stringify(files).length,
  };
}

function pathScore(path: string) {
  if (/(?:^|\/)(?:README|AGENTS|package\.json|go\.mod|openapi)/i.test(path)) return 0;
  if (/(?:^|\/)(?:app|src|pages|cmd|internal|docs|migrations)\//.test(path)) return 1;
  return 2;
}

function isSourcePath(path: string) {
  return /\.(?:ts|tsx|js|jsx|go|py|json|md|sql|yaml|yml|css|html)$/.test(path)
    && !/(?:node_modules|dist|\.next|coverage|vendor|package-lock|pnpm-lock|yarn\.lock|\.test\.|\.spec\.)/.test(path);
}

export async function getSourceSnapshot(repo: GitHubRepository, sha: string): Promise<SourceFile[]> {
  const tree = await githubFetch(`/repos/${repo.owner}/${repo.name}/git/trees/${sha}?recursive=1`) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
    truncated?: boolean;
  };
  const candidates = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && (entry.size ?? 0) <= 80_000 && isSourcePath(entry.path))
    .sort((a, b) => pathScore(a.path) - pathScore(b.path) || a.path.localeCompare(b.path))
    .slice(0, 28);

  let remaining = 100_000;
  const sources: SourceFile[] = [];
  for (const candidate of candidates) {
    if (remaining < 2_000) break;
    const data = await githubFetch(`/repos/${repo.owner}/${repo.name}/contents/${candidate.path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`) as {
      content?: string;
      encoding?: string;
    };
    if (!data.content || data.encoding !== "base64") continue;
    const content = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
    const numbered = content.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");
    const clipped = numbered.slice(0, Math.min(8_000, remaining));
    sources.push({ path: candidate.path, content: clipped });
    remaining -= clipped.length;
  }
  return sources;
}

export async function getBranchHead(repo: GitHubRepository) {
  const data = await githubFetch(`/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(repo.defaultBranch)}`) as {
    commit: { sha: string };
  };
  return data.commit.sha;
}

export function verifyGitHubSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
