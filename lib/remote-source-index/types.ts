import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { CodeHostingProvider, RepositoryAccess } from "../code-hosting/types";

export type RepositorySlug = string;
export type SourceRevisionSha = string;

export type SourceEntryType = "blob" | "tree" | "commit";

export type SourceIndexStatus = "indexed" | "partial" | "failed";

export type SourceBackendKind = "github_api" | "gitlab_api" | "blobless_git";

export type SourceSignal =
  | "manifest"
  | "entrypoint"
  | "route"
  | "controller"
  | "service"
  | "repository"
  | "database"
  | "migration"
  | "queue"
  | "worker"
  | "auth"
  | "config"
  | "deployment"
  | "frontend"
  | "native"
  | "test"
  | "generated"
  | "vendored";

export type PruneReason =
  | "outside_product_scope"
  | "third_party"
  | "generated"
  | "build_output"
  | "dependency_directory"
  | "binary_asset"
  | "too_large"
  | "documentation_only"
  | "test_fixture"
  | "lfs_pointer"
  | "policy";

export interface SourceRepositoryRef {
  owner: string;
  repo: string;
}

export interface SourceRevisionRef extends SourceRepositoryRef {
  revision: SourceRevisionSha;
}

export interface SourceScopeRoot {
  path: string;
  label?: string;
  role?: "web" | "api" | "worker" | "library" | "mobile" | "desktop" | "deployment" | "shared";
}

export interface SourceTreeApiEntry {
  path: string;
  type: SourceEntryType;
  sha: string;
  mode?: string;
  size?: number;
}

export interface SourceTreeEntry extends SourceTreeApiEntry {
  parentPath: string;
  extension?: string;
  signals: SourceSignal[];
  pruned?: {
    reason: PruneReason;
    detail?: string;
  };
}

export interface SourceTreeListing {
  path: string;
  entries: SourceTreeEntry[];
  truncated: boolean;
  status: SourceIndexStatus;
  metrics: {
    entryCount: number;
    prunedCount: number;
  };
}

export interface SourceBlobMeta {
  path: string;
  blobSha: string;
  treeEntrySha: string;
  byteSize: number;
  lineCount?: number;
  cacheState: "miss" | "cached" | "fetched";
}

export type SourceReadRequestedBy = "planner" | "profile" | "ai_explorer" | "evidence_verifier";

export interface SourceLineRequest {
  path: string;
  startLine: number;
  endLine: number;
  requestedBy: SourceReadRequestedBy;
  reason: string;
  maxBytes?: number;
}

export interface SourceLineSlice {
  path: string;
  blobSha: string;
  treeEntrySha: string;
  startLine: number;
  endLine: number;
  lines: string[];
  byteSize: number;
  lineCount: number;
  verified: true;
  cacheState: "cached" | "fetched";
  readReceipt: {
    requestedBy: SourceReadRequestedBy;
    reason: string;
    fetchedAt: string;
  };
}

export interface EvidenceRootRequest {
  revision: SourceRevisionRef;
  scopeRoots: SourceScopeRoot[];
  paths: Array<{ path: string; blobSha: string }>;
  outputRoot: string;
}

export interface EvidenceRootResult {
  rootPath: string;
  kind: "sparse_git_worktree" | "materialized_files";
  fileCount: number;
  byteSize: number;
  verified: boolean;
  missingPaths: string[];
}

export interface SourceMetrics {
  treeExpansions: number;
  blobFetches: number;
  contentBytes: number;
}

export interface RemoteSourceBudgets {
  maxTreeExpansions: number;
  maxBlobFetches: number;
  maxBlobBytes: number;
  maxLinesPerRead: number;
  maxTotalContentBytes: number;
}

export interface SourcePruningPolicy {
  excludedPrefixes: string[];
  excludedExtensions: string[];
  maxTrackedSourceBytes: number;
}

export interface SourceCacheOptions {
  maxCachedBlobs: number;
}

export interface FileSystemAdapter {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
}

export interface RemoteSourceIndexDependencies {
  backend?: RemoteSourceBackend;
  filesystem?: FileSystemAdapter;
  now?: () => Date;
}

export interface ResolvedRemoteSourceIndexDependencies {
  backend?: RemoteSourceBackend;
  filesystem: FileSystemAdapter;
  now: () => Date;
}

export interface RemoteSourceIndexOptions {
  scopeRoots: SourceScopeRoot[];
  access: RepositoryAccess;
  provider?: CodeHostingProvider;
  backend?: RemoteSourceBackend;
  budgets?: Partial<RemoteSourceBudgets>;
  pruning?: Partial<SourcePruningPolicy>;
  cache?: Partial<SourceCacheOptions>;
  dependencies?: RemoteSourceIndexDependencies;
}

export interface SourceRevisionIdentity {
  repository: RepositorySlug;
  revision: SourceRevisionSha;
  rootTreeSha: string;
  backend: SourceBackendKind;
  status: SourceIndexStatus;
}

export interface RemoteSourceBackend {
  kind: SourceBackendKind;
  resolveRevision(ref: SourceRepositoryRef): Promise<{ rootTreeSha: string }>;
  listTree(ref: SourceRevisionRef, treeSha: string, path: string): Promise<{ entries: SourceTreeApiEntry[]; truncated: boolean }>;
  /** Optional whole-tree listing (GitHub `recursive=1`). When absent, unavailable, or truncated, the index falls back to per-directory expansion. */
  listWholeTree?(ref: SourceRevisionRef, treeSha: string): Promise<{ entries: SourceTreeApiEntry[]; truncated: boolean }>;
  fetchBlob(ref: SourceRevisionRef, path: string, blobSha: string): Promise<Uint8Array>;
}

export interface OpenedRemoteSourceRevision {
  identity: SourceRevisionIdentity;
  scopeRoots: SourceScopeRoot[];
  metrics: SourceMetrics;
  listRoot(): Promise<SourceTreeListing>;
  listDir(path: string): Promise<SourceTreeListing>;
  expandPath(path: string): Promise<SourceTreeListing>;
  statPath(path: string): Promise<SourceBlobMeta | null>;
  readLines(request: SourceLineRequest): Promise<SourceLineSlice>;
  materializeEvidenceRoot(request: EvidenceRootRequest): Promise<EvidenceRootResult>;
}

export class SourceIndexError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SourceIndexError";
  }
}

export function gitBlobSha(content: string | Uint8Array) {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const digest = createHash("sha1");
  digest.update(header);
  digest.update(bytes);
  return digest.copy().digest("hex");
}

export const defaultRemoteSourceDependencies: ResolvedRemoteSourceIndexDependencies = {
  filesystem: { mkdir, writeFile },
  now: () => new Date(),
};

export const defaultRemoteSourceBudgets: RemoteSourceBudgets = {
  maxTreeExpansions: 400,
  maxBlobFetches: 160,
  maxBlobBytes: 1_000_000,
  maxLinesPerRead: 600,
  maxTotalContentBytes: 20_000_000,
};

export const defaultSourcePruningPolicy: SourcePruningPolicy = {
  excludedPrefixes: [".git/", "node_modules/", "vendor/", "third_party/", "dist/", "build/", "out/", "coverage/"],
  excludedExtensions: [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".mp4", ".mov", ".woff", ".woff2", ".lock", ".bin"],
  maxTrackedSourceBytes: 1_000_000,
};
