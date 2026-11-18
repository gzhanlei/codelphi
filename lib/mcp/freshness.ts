import { getDb, defaultExecute, type Execute } from "../db";
import { resolveAnalysisTarget } from "../code-hosting/analysis-target";
import { behavioralChangePaths } from "../patch-scan";

/**
 * 账本新鲜度（2026-11-19 P0，试点 F8「答案键 stale」元发现的读侧落地）：
 * 账本事实锚定在 analyzedSha（最新 release 的 sha），仓库 HEAD 领先时「历史正确≠当前正确」。
 * V1=版本级：analyzedSha vs 默认分支；V2-lite=逐场景：证据路径落在 analyzedSha..HEAD 的
 * 行为变更文件集内即标 stale（与 carry-forward 的行为变更集同口径）。
 *
 * 诚实语义：比较失败（网络/凭据）→ available=false，绝不把「查不到」伪装成「新鲜」。
 * 结果按 (repositoryId, analyzedSha) 缓存 5 分钟——MCP 查询频率远低于 GitHub compare 成本。
 */

export interface FreshnessBlock {
  available: true;
  repository: string;
  analyzedSha: string;
  comparedAgainst: string;
  /** analyzedSha..HEAD 的行为变更文件数（patch-scan 口径）。 */
  changedBehavioralFiles: number;
  /** analyzedSha..HEAD 的全部变更文件数。 */
  changedFiles: number;
}

export interface UnavailableFreshness {
  available: false;
  reason: string;
}

export type LedgerFreshness = FreshnessBlock | UnavailableFreshness;

export interface FreshnessData {
  block: LedgerFreshness;
  /** 行为变更文件路径全集（available=false 时为空集）。 */
  changedBehavioralPaths: ReadonlySet<string>;
}

interface CacheEntry {
  expires: number;
  data: FreshnessData;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

function cacheKey(repositoryId: number, analyzedSha: string): string {
  return `${repositoryId}#${analyzedSha}`;
}

export function resetFreshnessCacheForTests(): void {
  cache.clear();
}

interface FreshnessRepoRow {
  repositoryId: number;
  owner: string;
  name: string;
  connectionId: number | null;
  provider: string;
  analyzedSha: string;
}

async function loadFreshnessRepo(execute: Execute, productId: number): Promise<FreshnessRepoRow | null> {
  const [rows] = await execute(
    `SELECT r.id AS repositoryId, r.owner, r.name, r.connection_id AS connectionId, r.provider,
            rel.sha AS analyzedSha
     FROM releases rel
     JOIN repositories r ON r.id = rel.repository_id
     WHERE rel.product_id = ?
     ORDER BY rel.committed_at DESC, rel.id DESC
     LIMIT 1`,
    [productId],
  ) as [Array<FreshnessRepoRow>, unknown];
  return (Array.isArray(rows) ? rows : [])[0] ?? null;
}

export async function loadLedgerFreshness(
  productId: number,
  execute: Execute = defaultExecute,
  deps: {
    getRepository?: (input: { owner: string; name: string; defaultBranch: string }, access: { connectionId: number | null; organizationId: number }) => Promise<{ defaultBranch?: string }>;
    getChangeContext?: (repo: { defaultBranch?: string }, before: string, after: string, access: { connectionId: number | null; organizationId: number }) => Promise<{ files: ReadonlyArray<{ path: string; patch?: string; status?: string }> }>;
  } = {},
): Promise<FreshnessData> {
  const repo = await loadFreshnessRepo(execute, productId);
  if (!repo) return { block: { available: false, reason: "no_release" }, changedBehavioralPaths: new Set() };
  const key = cacheKey(repo.repositoryId, repo.analyzedSha);
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  const data = await computeFreshness(repo, execute, deps);
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, data });
  return data;
}

async function computeFreshness(
  repo: FreshnessRepoRow,
  execute: Execute,
  deps: {
    getRepository?: (input: { owner: string; name: string; defaultBranch: string }, access: { connectionId: number | null; organizationId: number }) => Promise<{ defaultBranch?: string }>;
    getChangeContext?: (repo: { defaultBranch?: string }, before: string, after: string, access: { connectionId: number | null; organizationId: number }) => Promise<{ files: ReadonlyArray<{ path: string; patch?: string; status?: string }> }>;
  },
): Promise<FreshnessData> {
  try {
    const [productRows] = await execute(
      "SELECT id, slug, name, organization_id AS organizationId FROM products WHERE id = (SELECT product_id FROM repositories WHERE id = ?)",
      [repo.repositoryId],
    ) as [Array<{ id: number; slug: string; name: string; organizationId: number }>, unknown];
    const product = (Array.isArray(productRows) ? productRows : [])[0];
    if (!product) return { block: { available: false, reason: "no_product" }, changedBehavioralPaths: new Set() };
    const target = resolveAnalysisTarget({
      productId: product.id,
      productSlug: product.slug,
      productName: product.name,
      connectionId: repo.connectionId,
      organizationId: product.organizationId,
      provider: repo.provider as "github" | "gitlab",
    });
    const baseRepo = { owner: repo.owner, name: repo.name, defaultBranch: "main" };
    const repository = deps.getRepository
      ? { ...baseRepo, ...(await deps.getRepository(baseRepo, target.access)) }
      : await target.adapter.getRepository(baseRepo, target.access);
    const branch = repository?.defaultBranch ?? "main";
    const change = deps.getChangeContext
      ? await deps.getChangeContext(repository, repo.analyzedSha, branch, target.access)
      : await target.adapter.getChangeContext(repository, repo.analyzedSha, branch, target.access);
    const files = Array.isArray(change.files) ? change.files : [];
    const behavioral = behavioralChangePaths(files);
    const block: FreshnessBlock = {
      available: true,
      repository: `${repo.owner}/${repo.name}`,
      analyzedSha: repo.analyzedSha,
      comparedAgainst: branch,
      changedBehavioralFiles: behavioral.size,
      changedFiles: files.length,
    };
    return { block, changedBehavioralPaths: behavioral };
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 160) : "unknown_error";
    return { block: { available: false, reason }, changedBehavioralPaths: new Set() };
  }
}

/** 当前进程内的 freshness 查询入口（MCP server 使用；连接与缓存共用默认池）。 */
export async function loadLedgerFreshnessForServer(productId: number): Promise<FreshnessData> {
  return loadLedgerFreshness(productId, getDb().execute.bind(getDb()) as unknown as Execute);
}
