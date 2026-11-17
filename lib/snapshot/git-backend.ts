import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { RemoteSourceBackend, SourceRepositoryRef, SourceTreeApiEntry } from "../remote-source-index";
import { gitText, runGit, SnapshotGitError } from "./git";

export interface GitSnapshot {
  repoRoot: string;
  revision: string;
  treeSha: string;
  branch: string | null;
  message: string;
  committedAt: string;
  workingTreeDirty: boolean;
  /** Remote blobless clones may fetch missing objects from their explicit origin. */
  allowLazyFetch?: boolean;
}

export interface ResolveGitSnapshotOptions {
  checkDirty?: boolean;
  allowLazyFetch?: boolean;
  /** Remote clones must not accidentally resolve to a parent repository. */
  requireExactRoot?: boolean;
}

export async function resolveGitSnapshot(repoRoot: string, revision = "HEAD", options: ResolveGitSnapshotOptions = {}): Promise<GitSnapshot> {
  if (!revision.trim()) throw new SnapshotGitError("invalid_revision", "Git revision must not be empty");
  const inputRoot = resolve(repoRoot);
  const root = gitText(await runGit(["-C", inputRoot, "rev-parse", "--show-toplevel"]));
  if (options.requireExactRoot && await realpath(root) !== await realpath(inputRoot)) {
    throw new SnapshotGitError("invalid_repository", "Git target resolved to a parent repository instead of the requested clone");
  }
  const sha = gitText(await runGit(["-C", root, "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`]));
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new SnapshotGitError("invalid_revision", "Git revision did not resolve to a commit");

  const metadata = (await runGit(["-C", root, "show", "-s", "--format=%H%x00%T%x00%cI%x00%s", sha, "--"])).toString("utf8").replace(/\n$/, "");
  const [commit, treeSha, committedAt, ...subject] = metadata.split("\0");
  if (!commit || !treeSha || !committedAt) throw new SnapshotGitError("invalid_revision", "Unable to read Git snapshot metadata");

  let branch: string | null = null;
  try {
    branch = gitText(await runGit(["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  } catch {
    // A detached HEAD is a valid snapshot, not a repository failure.
  }
  const workingTreeDirty = options.checkDirty === false
    ? false
    : (await runGit(["-C", root, "status", "--porcelain=v1", "--untracked-files=normal"])).byteLength > 0;

  return {
    repoRoot: root,
    revision: commit,
    treeSha,
    branch,
    message: subject.join("\0"),
    committedAt,
    workingTreeDirty,
    allowLazyFetch: options.allowLazyFetch,
  };
}

function parseTreeEntries(output: Buffer): SourceTreeApiEntry[] {
  if (output.byteLength === 0) return [];
  const records = output.toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  return records.map((record) => {
    const match = /^(\d+) (blob|tree|commit) ([0-9a-f]+) +(\d+|-)\t([\s\S]*)$/.exec(record);
    if (!match) throw new SnapshotGitError("invalid_tree", "Git returned an invalid tree entry");
    const [, mode, type, sha, size, path] = match;
    return {
      path,
      type: type as SourceTreeApiEntry["type"],
      sha,
      mode,
      ...(size === "-" ? {} : { size: Number(size) }),
    };
  });
}

export function createLocalGitBackend(snapshot: GitSnapshot): RemoteSourceBackend {
  const git = (args: string[], maxBufferBytes?: number) => runGit(["-C", snapshot.repoRoot, ...args], {
    allowLazyFetch: snapshot.allowLazyFetch,
    ...(maxBufferBytes ? { maxBufferBytes } : {}),
  });

  return {
    kind: "local_git",
    async resolveRevision(_ref: SourceRepositoryRef) {
      return { rootTreeSha: snapshot.treeSha };
    },
    async listTree(_ref, treeSha, _path) {
      if (!/^[0-9a-f]{40,64}$/.test(treeSha)) throw new SnapshotGitError("invalid_tree", "Invalid Git tree SHA");
      return { entries: parseTreeEntries(await git(["ls-tree", "-l", "-z", treeSha, "--"])), truncated: false };
    },
    async listWholeTree(_ref, treeSha) {
      if (!/^[0-9a-f]{40,64}$/.test(treeSha)) throw new SnapshotGitError("invalid_tree", "Invalid Git tree SHA");
      return { entries: parseTreeEntries(await git(["ls-tree", "-r", "-l", "-z", treeSha, "--"])), truncated: false };
    },
    async fetchBlob(_ref, _path, blobSha) {
      if (!/^[0-9a-f]{40,64}$/.test(blobSha)) throw new SnapshotGitError("invalid_blob", "Invalid Git blob SHA");
      const bytes = await git(["cat-file", "blob", blobSha]);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    },
  };
}
