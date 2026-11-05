import { isArchitectureSourcePath, type ArchitectureSource } from "./source";
import type { OpenedRemoteSourceRevision, RemoteSourceBudgets, SourceScopeRoot } from "../remote-source-index";

export interface ArchitectureRepositorySourceBudgets {
  maxFiles: number;
  maxDirectories: number;
  maxTotalBytes: number;
}

export interface ArchitectureRepositorySourceReceipt {
  scope: "repository";
  directories: number;
  files: number;
  bytes: number;
}

const defaultBudgets: ArchitectureRepositorySourceBudgets = {
  maxFiles: 1000,
  maxDirectories: 1000,
  maxTotalBytes: 10_000_000,
};

export const architectureSourceIndexBudgets: RemoteSourceBudgets = {
  maxTreeExpansions: 1000,
  maxBlobFetches: 1000,
  maxBlobBytes: 1_000_000,
  maxLinesPerRead: 600,
  maxTotalContentBytes: 10_000_000,
};

function assertDirectoryBudget(visited: number, maximum: number) {
  if (visited >= maximum) throw new Error("Architecture source directory budget exhausted");
}

async function completeListing(index: OpenedRemoteSourceRevision, directory: string) {
  const listing = await index.listDir(directory);
  if (listing.truncated || listing.status !== "indexed") throw new Error(`Architecture source tree incomplete: ${directory}`);
  return listing;
}

function visitEntries(listing: Awaited<ReturnType<OpenedRemoteSourceRevision["listDir"]>>, pending: string[], visited: Set<string>) {
  const files: string[] = [];
  for (const entry of [...listing.entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (entry.pruned) continue;
    if (entry.type === "tree") {
      if (!visited.has(entry.path)) pending.push(entry.path);
      continue;
    }
    if (entry.type === "blob" && isArchitectureSourcePath(entry.path)) files.push(entry.path);
  }
  return files;
}

async function architectureFiles(index: OpenedRemoteSourceRevision, scopeRoots: SourceScopeRoot[], budgets: ArchitectureRepositorySourceBudgets) {
  const pending = scopeRoots.map((root) => root.path).sort();
  const visited = new Set<string>();
  const files: string[] = [];
  while (pending.length > 0) {
    const directory = pending.shift() as string;
    if (visited.has(directory)) continue;
    assertDirectoryBudget(visited.size, budgets.maxDirectories);
    visited.add(directory);
    const listing = await completeListing(index, directory);
    files.push(...visitEntries(listing, pending, visited));
  }
  const uniqueFiles = [...new Set(files)].sort();
  if (uniqueFiles.length > budgets.maxFiles) throw new Error(`Architecture source file budget exhausted: ${uniqueFiles.length} files`);
  return { files: uniqueFiles, directories: visited.size };
}

async function readCompleteSource(index: OpenedRemoteSourceRevision, path: string) {
  const numbered: string[] = [];
  let startLine = 1;
  let bytes = 0;
  while (true) {
    const read = await index.readLines({
      path,
      startLine,
      endLine: startLine + 599,
      requestedBy: "evidence_verifier",
      reason: "architecture repository source inventory",
    });
    numbered.push(...read.lines.map((line, offset) => `${read.startLine + offset}: ${line}`));
    bytes += read.byteSize;
    if (read.lines.length === 0 || read.endLine >= read.lineCount) break;
    if (read.endLine < startLine) throw new Error(`Architecture source reader did not advance: ${path}`);
    startLine = read.endLine + 1;
  }
  return { source: { path, content: numbered.join("\n") }, bytes };
}

export async function loadArchitectureRepositorySources(
  index: OpenedRemoteSourceRevision,
  scopeRoots: SourceScopeRoot[],
  budgetOverrides: Partial<ArchitectureRepositorySourceBudgets> = {},
): Promise<{ sources: ArchitectureSource[]; receipt: ArchitectureRepositorySourceReceipt }> {
  const budgets = { ...defaultBudgets, ...budgetOverrides };
  const inventory = await architectureFiles(index, scopeRoots, budgets);
  const sources: ArchitectureSource[] = [];
  let bytes = 0;
  for (const path of inventory.files) {
    const read = await readCompleteSource(index, path);
    bytes += read.bytes;
    if (bytes > budgets.maxTotalBytes) throw new Error(`Architecture source byte budget exhausted: ${path}`);
    sources.push(read.source);
  }
  return { sources, receipt: { scope: "repository", directories: inventory.directories, files: sources.length, bytes } };
}
