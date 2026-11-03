import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import { SourceIndexError, defaultRemoteSourceBudgets, defaultRemoteSourceDependencies, defaultSourcePruningPolicy, gitBlobSha, type EvidenceRootRequest, type FileSystemAdapter, type EvidenceRootResult, type OpenedRemoteSourceRevision, type RemoteSourceBackend, type RemoteSourceIndexDependencies, type RemoteSourceIndexOptions, type RemoteSourceBudgets, type ResolvedRemoteSourceIndexDependencies, type SourceBlobMeta, type SourceCacheOptions, type SourceIndexStatus, type SourceLineRequest, type SourceLineSlice, type SourceMetrics, type SourcePruningPolicy, type PruneReason, type SourceRevisionIdentity, type SourceRevisionRef, type SourceScopeRoot, type SourceSignal, type SourceTreeApiEntry, type SourceTreeEntry, type SourceTreeListing } from "./types";
import { createGitHubSourceBackend } from "./github-backend";

interface CachedBlob {
  path: string;
  blobSha: string;
  treeEntrySha: string;
  bytes: Uint8Array;
}

interface SourceIndexState {
  entries: Map<string, SourceTreeEntry>;
  listings: Map<string, SourceTreeListing>;
  blobs: Map<string, CachedBlob>;
  metrics: SourceMetrics;
}

function normalizeSourcePath(path: string) {
  const normalized = normalize(path).replaceAll(sep, "/").replace(/^\.?\//, "").replace(/\/+$/g, "");
  return normalized === "." ? "" : normalized;
}

function childPath(parentPath: string, name: string) {
  return parentPath ? `${parentPath}/${name}` : name;
}

function isDescendant(path: string, scopePath: string) {
  return scopePath === "" || path === scopePath || path.startsWith(`${scopePath}/`);
}

function hasSegment(path: string, value: string) {
  return path.split("/").includes(value);
}

const baseSignalRules: Array<{ match: (path: string, name: string) => boolean; signals: SourceSignal[] }> = [
  { match: (_path, name) => ["package.json", "go.mod", "cargo.toml", "pom.xml", "build.gradle", "androidmanifest.xml", "dockerfile", "docker-compose.yml", "cmakelists.txt", "readme.md", "agents.md"].includes(name), signals: ["manifest"] },
  { match: (_path, name) => ["main.go", "main.ts", "index.ts", "server.ts", "app.ts", "application.java"].includes(name) || /(?:page|route|activity|service)\.(?:tsx|ts|java)$/.test(name), signals: ["entrypoint"] },
  { match: (_path, name) => /(?:route|controller|handler|endpoint)/.test(name), signals: ["route"] },
  { match: (_path, name) => /(?:repository|model|entity)/.test(name), signals: ["repository"] },
  { match: (_path, name) => /(?:database|db|postgres|mysql|sqlite)/.test(name) || /\.sql$/.test(name), signals: ["database", "migration"] },
  { match: (_path, name) => /(?:queue|worker|job)/.test(name), signals: ["queue", "worker"] },
  { match: (path, name) => /(?:^|\/)(?:oauth|auth)(?:\/|\.)/.test(path) || /(?:auth|oauth)/.test(name), signals: ["auth"] },
  { match: (path) => /\.(?:java|kt|py|cs|php|go|rs|rb|ts|tsx|jsx|mjs|cjs)$/.test(path), signals: ["service"] },
  { match: (_path, name) => /(?:dockerfile|docker-compose|deploy|k8s|kubernetes)/.test(name), signals: ["deployment"] },
  { match: (path, name) => /\.(?:tsx|jsx)$/.test(name) || hasSegment(path, "app") && /\.tsx$/.test(name), signals: ["frontend"] },
  { match: (_path, name) => /\.(?:java|kt|swift|m|mm|c|cc|cpp|h|hpp)$/.test(name), signals: ["native"] },
  { match: (_path, name) => /(?:\.test\.|\.spec\.|__tests__)/.test(name), signals: ["test"] },
  { match: (_path, name) => /(?:generated|\.pb\.go|\.g\.dart|\.next)/.test(name), signals: ["generated"] },
];

export function baseSignals(path: string): SourceSignal[] {
  const name = basename(path).toLowerCase();
  return baseSignalRules.filter((rule) => rule.match(path, name)).flatMap((rule) => rule.signals);
}

export function dependencyPruneReason(path: string): PruneReason {
  if (path === "third_party" || path.startsWith("third_party/") || path === "vendor" || path.startsWith("vendor/")) return "third_party";
  if (path === "node_modules" || path.startsWith("node_modules/")) return "dependency_directory";
  return "build_output";
}

function excludedPruneReason(path: string, policy: SourcePruningPolicy): PruneReason | undefined {
  return policy.excludedPrefixes.some((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix))
    ? dependencyPruneReason(path)
    : undefined;
}

export function contentPruneReason(path: string, raw: SourceTreeApiEntry, policy: SourcePruningPolicy, extension?: string): PruneReason | undefined {
  if (raw.type !== "blob") return undefined;
  if (/(?:^|\/)(?:generated|__generated__)(?:\/|$)/.test(path)) return "generated";
  if (extension !== undefined && policy.excludedExtensions.includes(extension)) return "binary_asset";
  if (raw.size !== undefined && raw.size > policy.maxTrackedSourceBytes) return "too_large";
  return undefined;
}

export function scopePruneReason(parentPath: string, path: string, raw: SourceTreeApiEntry, scopeRoots: SourceScopeRoot[]): PruneReason | undefined {
  if (parentPath !== "" || scopeRoots.length === 0) return undefined;
  if (scopeRoots.some((scope) => isDescendant(path, scope.path) || scope.path.startsWith(`${path}/`))) return undefined;
  if (raw.type === "blob" && baseSignals(path).includes("manifest")) return undefined;
  return "outside_product_scope";
}

export function classifyEntry(parentPath: string, raw: SourceTreeApiEntry, policy: SourcePruningPolicy, scopeRoots: SourceScopeRoot[]): SourceTreeEntry {
  const path = parentPath && !raw.path.startsWith(`${parentPath}/`) ? childPath(parentPath, raw.path) : raw.path;
  const extension = path.includes(".") ? `.${path.split(".").pop()?.toLowerCase()}` : undefined;
  const pruneReason = excludedPruneReason(path, policy) ?? contentPruneReason(path, raw, policy, extension) ?? scopePruneReason(parentPath, path, raw, scopeRoots);

  return {
    path,
    parentPath,
    type: raw.type,
    sha: raw.sha,
    mode: raw.mode,
    size: raw.size,
    extension,
    signals: raw.type === "blob" ? baseSignals(path) : [],
    pruned: pruneReason ? { reason: pruneReason } : undefined,
  };
}

export function textLineCount(content: string) {
  const lines = content.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function boundedLineRange(lines: string[], startLine: number, endLine: number, maxLines: number) {
  const start = Math.max(1, Math.min(startLine, lines.length || 1));
  const end = Math.max(start, Math.min(lines.length || 1, endLine, start + maxLines - 1));
  return { startLine: start, endLine: end, lines: lines.slice(start - 1, end) };
}

class RemoteSourceRevision implements OpenedRemoteSourceRevision {
  readonly identity: SourceRevisionIdentity;
  readonly scopeRoots: SourceScopeRoot[];
  readonly metrics: SourceMetrics;

  private readonly ref: SourceRevisionRef;
  private readonly backend: RemoteSourceBackend;
  private readonly budgets: RemoteSourceBudgets;
  private readonly policy: SourcePruningPolicy;
  private readonly cache: SourceCacheOptions;
  private readonly filesystem: FileSystemAdapter;
  private readonly now: () => Date;
  private readonly state: SourceIndexState;

  constructor(ref: SourceRevisionRef, identity: SourceRevisionIdentity, rootListing: SourceTreeListing, options: RemoteSourceIndexOptions, dependencies: ResolvedRemoteSourceIndexDependencies, backend: RemoteSourceBackend) {
    this.ref = ref;
    this.identity = identity;
    this.scopeRoots = options.scopeRoots;
    this.backend = backend;
    this.budgets = { ...defaultRemoteSourceBudgets, ...options.budgets };
    this.policy = { ...defaultSourcePruningPolicy, ...options.pruning };
    this.cache = { maxCachedBlobs: 64, ...options.cache };
    this.filesystem = dependencies.filesystem;
    this.now = dependencies.now;
    this.state = { entries: new Map(), listings: new Map(), blobs: new Map(), metrics: { treeExpansions: 0, blobFetches: 0, contentBytes: 0 } };
    this.state.listings.set("", rootListing);
    for (const entry of rootListing.entries) this.state.entries.set(entry.path, entry);
    this.metrics = this.state.metrics;
  }

  async listRoot() {
    return this.state.listings.get("")!;
  }

  async listDir(path: string) {
    const normalized = normalizeSourcePath(path);
    if (!normalized) return this.listRoot();
    this.assertAllowed(normalized, "list");
    return this.ensureListing(normalized);
  }

  async expandPath(path: string) {
    return this.listDir(path);
  }

  async statPath(path: string): Promise<SourceBlobMeta | null> {
    const normalized = normalizeSourcePath(path);
    this.assertAllowed(normalized, "stat");
    const entry = await this.findEntry(normalized);
    if (!entry) return null;
    if (entry.type !== "blob") return null;
    if (entry.pruned) return null;
    const cached = this.state.blobs.get(normalized);
    return {
      path: normalized,
      blobSha: entry.sha,
      treeEntrySha: entry.sha,
      byteSize: entry.size ?? cached?.bytes.byteLength ?? 0,
      lineCount: cached ? textLineCount(decodeUtf8(cached.bytes)) : undefined,
      cacheState: cached ? "cached" : "miss",
    };
  }

  async readLines(request: SourceLineRequest): Promise<SourceLineSlice> {
    const path = normalizeSourcePath(request.path);
    this.assertAllowed(path, "read");
    if (request.startLine < 1 || request.endLine < request.startLine) throw new SourceIndexError("invalid_line_range", "line range must start at 1 and end at or after startLine");
    const entry = await this.findEntry(path);
    if (!entry || entry.type !== "blob") throw new SourceIndexError("path_not_found", `source file was not found: ${path}`);
    if (entry.pruned) throw new SourceIndexError("path_pruned", `source file is pruned (${entry.pruned.reason}): ${path}`);

    const wasCached = this.state.blobs.has(path);
    const bytes = await this.fetchVerifiedBlob(path, entry);
    const cacheState = wasCached ? "cached" : "fetched";
    const content = decodeUtf8(bytes);
    const rawLines = content.split("\n");
    const lines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines;
    const range = boundedLineRange(lines, request.startLine, request.endLine, this.budgets.maxLinesPerRead);
    const startLine = range.startLine;
    const endLine = range.endLine;
    const selected = range.lines;
    const byteSize = Buffer.byteLength(selected.join("\n"), "utf8");
    this.consumeContentBytes(byteSize);

    return {
      path,
      blobSha: entry.sha,
      treeEntrySha: entry.sha,
      startLine,
      endLine,
      lines: selected,
      byteSize,
      lineCount: lines.length,
      verified: true,
      cacheState,
      readReceipt: {
        requestedBy: request.requestedBy,
        reason: request.reason,
        fetchedAt: this.now().toISOString(),
      },
    };
  }

  async materializeEvidenceRoot(request: EvidenceRootRequest): Promise<EvidenceRootResult> {
    const rootPath = resolve(request.outputRoot);
    const missingPaths: string[] = [];
    let fileCount = 0;
    let byteSize = 0;

    for (const item of request.paths) {
      const path = normalizeSourcePath(item.path);
      const entry = this.state.entries.get(path);
      if (!entry || entry.type !== "blob" || entry.sha !== item.blobSha) {
        missingPaths.push(path);
        continue;
      }
      const bytes = await this.fetchVerifiedBlob(path, entry);
      const target = join(rootPath, path);
      if (!target.startsWith(`${rootPath}${sep}`)) throw new SourceIndexError("evidence_path_invalid", "materialized path escapes evidence root");
      await this.filesystem.mkdir(dirname(target), { recursive: true });
      await this.filesystem.writeFile(target, bytes);
      fileCount += 1;
      byteSize += bytes.byteLength;
    }

    return {
      rootPath,
      kind: "materialized_files",
      fileCount,
      byteSize,
      verified: missingPaths.length === 0,
      missingPaths,
    };
  }

  private async findEntry(path: string): Promise<SourceTreeEntry | null> {
    if (!path) return { path: "", parentPath: "", type: "tree", sha: this.identity.rootTreeSha, signals: [] };
    const cached = this.state.entries.get(path);
    if (cached) return cached;
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const parent = await this.findEntry(parentPath);
    if (!parent) return null;
    if (parent.type !== "tree") return null;
    if (parent.pruned) return null;
    await this.ensureListing(parentPath);
    const entry = this.state.entries.get(path);
    return entry ?? null;
  }

  private async ensureListing(path: string): Promise<SourceTreeListing> {
    const cached = this.state.listings.get(path);
    if (cached) return cached;
    const entry = await this.findEntry(path);
    if (!entry || entry.type !== "tree") throw new SourceIndexError("tree_not_found", `source tree was not found: ${path}`);
    if (this.state.metrics.treeExpansions >= this.budgets.maxTreeExpansions) throw new SourceIndexError("budget_exhausted", "tree expansion budget was exhausted");
    const response = await this.backend.listTree(this.ref, entry.sha, path);
    const listing = this.createListing(path, response.entries, response.truncated);
    this.state.listings.set(path, listing);
    this.state.metrics.treeExpansions += 1;
    return listing;
  }

  private createListing(path: string, rawEntries: SourceTreeApiEntry[], truncated: boolean): SourceTreeListing {
    const entries = rawEntries.map((entry) => classifyEntry(path, entry, this.policy, this.scopeRoots));
    for (const entry of entries) this.state.entries.set(entry.path, entry);
    return {
      path,
      entries,
      truncated,
      status: truncated ? "partial" : "indexed",
      metrics: {
        entryCount: entries.length,
        prunedCount: entries.filter((entry) => entry.pruned).length,
      },
    };
  }

  private async fetchVerifiedBlob(path: string, entry: SourceTreeEntry) {
    const cached = this.state.blobs.get(path);
    if (cached && cached.blobSha === entry.sha) return cached.bytes;
    if (this.state.metrics.blobFetches >= this.budgets.maxBlobFetches) throw new SourceIndexError("budget_exhausted", "blob fetch budget was exhausted");
    const blobSize = entry.size;
    if (blobSize !== undefined && blobSize > this.budgets.maxBlobBytes) throw new SourceIndexError("blob_too_large", `source blob exceeds max bytes: ${path}`);

    const bytes = await this.backend.fetchBlob(this.ref, path, entry.sha);
    const actualSha = gitBlobSha(bytes);
    if (actualSha !== entry.sha) throw new SourceIndexError("blob_sha_mismatch", `blob SHA mismatch for ${path}: expected ${entry.sha}, got ${actualSha}`);
    this.state.blobs.set(path, { path, blobSha: entry.sha, treeEntrySha: entry.sha, bytes });
    this.trimBlobCache();
    this.state.metrics.blobFetches += 1;
    this.state.metrics.contentBytes += bytes.byteLength;
    return bytes;
  }

  private trimBlobCache() {
    while (this.state.blobs.size > this.cache.maxCachedBlobs) {
      const oldest = this.state.blobs.keys().next();
      if (oldest.done) break;
      this.state.blobs.delete(oldest.value);
    }
  }

  private consumeContentBytes(byteSize: number) {
    if (this.state.metrics.contentBytes + byteSize > this.budgets.maxTotalContentBytes) throw new SourceIndexError("budget_exhausted", "remote source content budget was exhausted");
    this.state.metrics.contentBytes += byteSize;
  }

  private assertAllowed(path: string, operation: "list" | "read" | "stat") {
    if (!path) return;
    if (this.scopeRoots.length === 0) return;
    if (this.scopeRoots.some((scope) => isDescendant(path, scope.path))) return;
    if (operation === "list" && this.scopeRoots.some((scope) => scope.path.startsWith(`${path}/`))) return;
    if (operation === "read" && !path.includes("/") && baseSignals(path).includes("manifest")) return;
    throw new SourceIndexError("path_outside_product_scope", "path is outside product scope");
  }
}

function decodeUtf8(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SourceIndexError("binary_source", "source blob is not valid UTF-8");
  }
}

export function resolveRemoteSourceDependencies(dependencies?: RemoteSourceIndexDependencies): ResolvedRemoteSourceIndexDependencies {
  if (dependencies) {
    return {
      backend: dependencies.backend,
      filesystem: dependencies.filesystem || defaultRemoteSourceDependencies.filesystem,
      now: dependencies.now || defaultRemoteSourceDependencies.now,
    };
  }
  return defaultRemoteSourceDependencies;
}

function resolveRemoteSourceBackend(options: RemoteSourceIndexOptions, dependencies: ResolvedRemoteSourceIndexDependencies): RemoteSourceBackend {
  if (options.backend) return options.backend;
  if (dependencies.backend) return dependencies.backend;
  return createGitHubSourceBackend({ access: options.access });
}

export async function createRemoteSourceIndex(ref: SourceRevisionRef, options: RemoteSourceIndexOptions): Promise<OpenedRemoteSourceRevision> {
  const dependencies = resolveRemoteSourceDependencies(options.dependencies);
  const backend = resolveRemoteSourceBackend(options, dependencies);
  const identity = await backend.resolveRevision(ref);
  const response = await backend.listTree({ ...ref, revision: ref.revision }, identity.rootTreeSha, "");
  const policy: SourcePruningPolicy = { ...defaultSourcePruningPolicy, ...options.pruning };
  const rootEntries = response.entries.map((entry) => classifyEntry("", entry, policy, options.scopeRoots));
  const rootListing = {
    path: "",
    entries: rootEntries,
    truncated: response.truncated,
    status: (response.truncated ? "partial" : "indexed") as SourceIndexStatus,
    metrics: {
      entryCount: response.entries.length,
      prunedCount: rootEntries.filter((entry) => entry.pruned).length,
    },
  };
  return new RemoteSourceRevision(ref, {
    repository: `${ref.owner}/${ref.repo}`,
    revision: ref.revision,
    rootTreeSha: identity.rootTreeSha,
    backend: backend.kind,
    status: rootListing.status,
  }, rootListing, options, dependencies, backend);
}

export { normalizeSourcePath };
