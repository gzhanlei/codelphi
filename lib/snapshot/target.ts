import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RemoteSourceBackend } from "../remote-source-index";
import { createLocalGitBackend, resolveGitSnapshot } from "./git-backend";
import { runGit, SnapshotGitError } from "./git";
import type { SnapshotIdentity } from "./types";

export interface GitHubRepositoryTarget {
  owner: string;
  name: string;
  url: string;
}

export function parseGitHubRepository(target: string): GitHubRepositoryTarget {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new SnapshotGitError("invalid_target", "Invalid GitHub repository URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SnapshotGitError("invalid_target", "Only public https://github.com/owner/repo URLs are supported");
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) throw new SnapshotGitError("invalid_target", "GitHub repository URL must use owner/repo format");
  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(segments[0]);
    name = decodeURIComponent(segments[1]);
  } catch {
    throw new SnapshotGitError("invalid_target", "Invalid GitHub repository URL encoding");
  }
  if (name.endsWith(".git")) name = name.slice(0, -4);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name) || !name) {
    throw new SnapshotGitError("invalid_target", "Invalid GitHub owner or repository name");
  }
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

export interface ResolvedSnapshotTarget {
  identity: SnapshotIdentity;
  repositoryRoot: string;
  backend: RemoteSourceBackend;
  cleanup: () => Promise<void>;
}

export interface ResolveSnapshotTargetOptions {
  clone?: (url: string, destination: string) => Promise<void>;
}

export async function resolveSnapshotTarget(target: string, ref?: string, options: ResolveSnapshotTargetOptions = {}): Promise<ResolvedSnapshotTarget> {
  const looksRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.startsWith("git@");
  if (!looksRemote) {
    const snapshot = await resolveGitSnapshot(target, ref);
    return {
      repositoryRoot: snapshot.repoRoot,
      identity: {
        source: "local",
        name: basename(snapshot.repoRoot),
        target: snapshot.repoRoot,
        revision: snapshot.revision,
        branch: snapshot.branch,
        message: snapshot.message,
        committedAt: snapshot.committedAt,
        workingTreeDirty: snapshot.workingTreeDirty,
      },
      backend: createLocalGitBackend(snapshot),
      cleanup: async () => undefined,
    };
  }

  const repository = parseGitHubRepository(target);
  if (ref !== undefined && !ref.trim()) throw new SnapshotGitError("invalid_revision", "Git ref must not be empty");
  if (ref?.startsWith("-")) throw new SnapshotGitError("invalid_revision", "Git ref must not start with an option prefix");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "codelphi-snapshot-clone-"));
  const cloneRoot = join(temporaryRoot, "repository");
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(temporaryRoot, { recursive: true, force: true });
  };
  try {
    const clone = options.clone ?? (async (url: string, destination: string) => {
      await runGit(["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", url, destination], {
        cwd: temporaryRoot,
        allowLazyFetch: true,
        timeoutMs: 120_000,
      });
    });
    await clone(repository.url, cloneRoot);
    if (ref) {
      await runGit(["-C", cloneRoot, "fetch", "--depth", "1", "--", "origin", ref], { allowLazyFetch: true, timeoutMs: 120_000 });
    }
    const snapshot = await resolveGitSnapshot(cloneRoot, ref ? "FETCH_HEAD" : "HEAD", { checkDirty: false, allowLazyFetch: true, requireExactRoot: true });
    return {
      repositoryRoot: snapshot.repoRoot,
      identity: {
        source: "github",
        name: repository.name,
        owner: repository.owner,
        target: repository.url,
        repositoryUrl: repository.url,
        revision: snapshot.revision,
        branch: snapshot.branch,
        message: snapshot.message,
        committedAt: snapshot.committedAt,
        workingTreeDirty: false,
      },
      backend: createLocalGitBackend(snapshot),
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
