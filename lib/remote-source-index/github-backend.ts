import { z } from "zod";
import { resolveGitHubToken, type GitHubAccess } from "../github-access";
import { SourceIndexError, type RemoteSourceBackend, type SourceRevisionRef, type SourceTreeApiEntry } from "./types";

const treeResponseSchema = z.object({
  sha: z.string().min(1),
  truncated: z.boolean().default(false),
  tree: z.array(z.object({
    path: z.string().min(1),
    type: z.enum(["blob", "tree", "commit"]),
    sha: z.string().min(1),
    mode: z.string().optional(),
    size: z.number().int().nonnegative().optional(),
  })),
});

const blobResponseSchema = z.object({
  sha: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["base64", "utf-8", "utf8"]),
});

function repositoryPath(ref: { owner: string; repo: string }) {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

function encodeSourcePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export interface GitHubSourceBackendOptions {
  access?: GitHubAccess;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function decodeBlob(data: z.infer<typeof blobResponseSchema>) {
  if (data.encoding === "base64") return new Uint8Array(Buffer.from(data.content.replace(/\s/g, ""), "base64"));
  return new TextEncoder().encode(data.content);
}

function mapTreeEntries(tree: Array<z.infer<typeof treeResponseSchema>["tree"][number]>): SourceTreeApiEntry[] {
  return tree.map((entry) => ({ path: entry.path, type: entry.type, sha: entry.sha, mode: entry.mode, size: entry.size }));
}

export function createGitHubSourceBackend(options: GitHubSourceBackendOptions = {}): RemoteSourceBackend {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function request(path: string, access: GitHubAccess) {
    const token = await resolveGitHubToken(access);
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "radar-remote-source-index",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new SourceIndexError("github_request_failed", `GitHub API ${response.status}: ${await response.text()}`);
    return response.json() as Promise<unknown>;
  }

  return {
    kind: "github_api",
    async resolveRevision(ref: SourceRevisionRef) {
      const data = treeResponseSchema.parse(await request(`${repositoryPath(ref)}/git/trees/${ref.revision}`, options.access ?? {}));
      return { rootTreeSha: data.sha };
    },
    async listTree(ref: SourceRevisionRef, treeSha: string) {
      const data = treeResponseSchema.parse(await request(`${repositoryPath(ref)}/git/trees/${encodeURIComponent(treeSha)}`, options.access ?? {}));
      return { entries: mapTreeEntries(data.tree), truncated: data.truncated };
    },
    async fetchBlob(ref: SourceRevisionRef, _path: string, blobSha: string) {
      const data = blobResponseSchema.parse(await request(`${repositoryPath(ref)}/git/blobs/${encodeURIComponent(blobSha)}`, options.access ?? {}));
      return decodeBlob(data);
    },
  };
}

export { repositoryPath, encodeSourcePath };
