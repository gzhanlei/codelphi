import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RemoteSourceBackend, SourceRepositoryRef, SourceRevisionRef, SourceTreeApiEntry } from "./types";

/**
 * 本地 git 后端（SourceBackendKind="local_git"）：从本地 git 仓库目录直接读取 tree/blob，
 * 不经任何远端 API——bench/自托管场景零 rate limit，源码读取变为本地磁盘速度。
 * revision 必须在该仓库可达（clone/checkout 由调用方保证）。
 */

const execFileAsync = promisify(execFile);

export interface LocalGitBackendOptions {
  /** 本地 git 仓库目录（含 .git；必须是完整 clone，revision 在其中可达）。 */
  repoDir: string;
  /** 可选工作目录兜底：fetchBlob 未命中 blob sha 时按 path 从工作树读取（浅 clone 场景）。 */
  worktreeFallback?: boolean;
}

async function git(repoDir: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoDir, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  return stdout;
}

export function createLocalGitBackend(options: LocalGitBackendOptions): RemoteSourceBackend {
  const { repoDir } = options;
  return {
    kind: "local_git",
    async resolveRevision(ref: SourceRepositoryRef): Promise<{ rootTreeSha: string }> {
      // index 以 SourceRevisionRef（含 revision）调用；参数收缩为 SourceRepositoryRef 是接口定义
      const revision = (ref as SourceRevisionRef).revision;
      const rootTreeSha = (await git(repoDir, ["rev-parse", `${revision}^{tree}`])).trim();
      return { rootTreeSha };
    },
    async listTree(_ref: SourceRevisionRef, treeSha: string, path: string): Promise<{ entries: SourceTreeApiEntry[]; truncated: boolean }> {
      const scope = path && path !== "" && path !== "." ? `${treeSha}:${path}` : treeSha;
      const output = await git(repoDir, ["ls-tree", scope]);
      const entries = output
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          const [meta, ...pathParts] = line.split("\t");
          const [mode, type, sha] = meta.split(/\s+/);
          return { path: pathParts.join("\t"), type: type as "blob" | "tree" | "commit", sha, mode };
        });
      return { entries, truncated: false };
    },
    async listWholeTree(ref: SourceRevisionRef, treeSha: string): Promise<{ entries: SourceTreeApiEntry[]; truncated: boolean }> {
      // -z 零分隔避免路径含空格/制表符被拆
      const output = await git(repoDir, ["ls-tree", "-r", "-z", "-l", treeSha]);
      const entries: SourceTreeApiEntry[] = [];
      for (const record of output.split("\0")) {
        if (record.length === 0) continue;
        const [meta, path] = record.split("\t");
        if (!path) continue;
        const [mode, type, sha, size] = meta.split(/\s+/);
        entries.push({ path, type: type as "blob" | "tree" | "commit", sha, mode, size: Number(size) });
      }
      return { entries, truncated: false };
    },
    async fetchBlob(_ref: SourceRevisionRef, _path: string, blobSha: string): Promise<Uint8Array> {
      const output = await git(repoDir, ["cat-file", "blob", blobSha]);
      return new TextEncoder().encode(output);
    },
  };
}
