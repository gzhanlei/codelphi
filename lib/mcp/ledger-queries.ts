import type { Execute } from "../db";

export interface LedgerProduct {
  id: number;
  slug: string;
  name: string;
  description: string;
}

export async function queryRows<T>(promise: Promise<unknown>): Promise<T[]> {
  const result = (await promise) as unknown;
  if (!Array.isArray(result)) return [];
  const first = result[0];
  if (Array.isArray(first)) return first as T[];
  return result as T[];
}

export async function resolveOrgProduct(execute: Execute, organizationId: number, slug: string) {
  const rows = await queryRows<LedgerProduct>(
    execute("SELECT id, slug, name, description FROM products WHERE organization_id = ? AND slug = ?", [organizationId, slug]),
  );
  return rows[0] ?? null;
}

export async function resolveEvidenceSource(execute: Execute, productId: number) {
  const repos = await queryRows<{ provider: string; owner: string; name: string; defaultBranch: string; sha: string | null }>(
    execute(
      `SELECT r.provider, r.owner, r.name, r.default_branch AS defaultBranch,
            (SELECT ar.after_sha FROM analysis_runs ar WHERE ar.repository_id = r.id AND ar.status = 'succeeded' ORDER BY ar.id DESC LIMIT 1) AS sha
     FROM repositories r
     WHERE r.product_id = ? LIMIT 1`,
      [productId],
    ),
  );
  const repo = repos[0];
  if (!repo) return null;
  const blobUrl = (path: string, startLine?: number) => {
    if (repo.provider !== "github" || !repo.sha) return null;
    return `https://github.com/${repo.owner}/${repo.name}/blob/${repo.sha}/${path}${startLine ? `#L${startLine}` : ""}`;
  };
  return { repo, blobUrl };
}

export function decorateEvidence(evidence: unknown, source: Awaited<ReturnType<typeof resolveEvidenceSource>>) {
  const items = Array.isArray(evidence) ? evidence : [];
  return items.map((item) => {
    const record = item as { path?: string; startLine?: number };
    return {
      path: record.path,
      startLine: record.startLine ?? null,
      url: source && record.path ? source.blobUrl(record.path, record.startLine) : null,
    };
  });
}
