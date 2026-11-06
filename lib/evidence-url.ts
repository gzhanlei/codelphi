import type { Evidence } from "./types";

const shaPattern = /^[0-9a-f]{7,40}$/i;

function isValidEvidencePath(path: string) {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return !path.split("/").includes("..");
}

function encodeEvidencePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function evidenceUrl(repo: { owner: string; name: string }, sha: string, item: Evidence): string | null {
  if (!shaPattern.test(sha) || !isValidEvidencePath(item.path)) return null;
  const anchor = item.startLine && item.startLine > 0
    ? `#L${item.startLine}${item.endLine && item.endLine > item.startLine ? `-L${item.endLine}` : ""}`
    : "";
  return `https://github.com/${repo.owner}/${repo.name}/blob/${sha}/${encodeEvidencePath(item.path)}${anchor}`;
}
