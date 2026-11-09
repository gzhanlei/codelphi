import { z } from "zod";
import { gitlabFetch, gitlabToken, type GitlabRepository } from "../gitlab";
import { SourceIndexError, type RemoteSourceBackend, type SourceRevisionRef, type SourceTreeApiEntry } from "./types";

const treeEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["blob", "tree"]),
  path: z.string().min(1),
  mode: z.string().optional(),
});

const blobResponseSchema = z.object({
  content: z.string(),
  encoding: z.string(),
  size: z.number().int().nonnegative().optional(),
});

/** SourceRevisionRef 用 owner/repo，GitlabRepository 用 owner/name——两者拼出的项目路径一致。 */
function projectPath(ref: { owner: string; repo?: string; name?: string }) {
  return encodeURIComponent(`${ref.owner}/${ref.repo ?? ref.name}`);
}

export interface GitlabSourceBackendOptions {
  access: { token?: string; connectionId?: number | null; organizationId?: number };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** GitLab 树 API 的 blob 条目不带 size；索引侧容忍缺失（按读取内容计）。 */
export function createGitlabSourceBackend(options: GitlabSourceBackendOptions): RemoteSourceBackend {
  const { access, fetchImpl = fetch, timeoutMs = 30_000 } = options;
  void timeoutMs;

  async function request(path: string) {
    const token = gitlabToken(access);
    void token;
    try {
      return await gitlabFetch(path, access);
    } catch (error) {
      throw new SourceIndexError("gitlab_request_failed", `GitLab API request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    kind: "gitlab_api",
    async resolveRevision(ref: SourceRevisionRef) {
      // GitLab 的树以 commit sha 寻址；根树即 revision 本身
      const data = z.object({ id: z.string().min(1) }).parse(await request(`/projects/${projectPath(ref)}/repository/commits/${encodeURIComponent(ref.revision)}`));
      return { rootTreeSha: data.id };
    },
    async listTree(ref: SourceRevisionRef, treeSha: string, path: string) {
      const entries = await request(
        `/projects/${projectPath(ref)}/repository/tree?ref=${encodeURIComponent(treeSha)}&per_page=100${path ? `&path=${encodeURIComponent(path)}` : ""}`,
      ) as unknown[];
      return { entries: z.array(treeEntrySchema).parse(entries).map(mapEntry), truncated: false };
    },
    async listWholeTree(ref: SourceRevisionRef, treeSha: string) {
      const entries = await request(
        `/projects/${projectPath(ref)}/repository/tree?ref=${encodeURIComponent(treeSha)}&recursive=1&per_page=100`,
      ) as unknown[];
      return { entries: z.array(treeEntrySchema).parse(entries).map(mapEntry), truncated: false };
    },
    async fetchBlob(ref: SourceRevisionRef, path: string, _blobSha: string) {
      // GitLab 按 blob sha 取内容；sha 缺失时按路径取
      const data = _blobSha
        ? blobResponseSchema.parse(await request(`/projects/${projectPath(ref)}/repository/blobs/${encodeURIComponent(_blobSha)}`))
        : blobResponseSchema.parse(await request(`/projects/${projectPath(ref)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref.revision)}`));
      return decodeBlob(data);
    },
  };
}

function mapEntry(entry: z.infer<typeof treeEntrySchema>): SourceTreeApiEntry {
  return { path: entry.path, type: entry.type, sha: entry.id, mode: entry.mode };
}

function decodeBlob(data: z.infer<typeof blobResponseSchema>): Uint8Array {
  if (data.encoding === "base64") return new Uint8Array(Buffer.from(data.content.replace(/\s/g, ""), "base64"));
  return new TextEncoder().encode(data.content);
}
