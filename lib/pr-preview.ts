import { getDb } from "./db";
import { getCodeHostingAdapter } from "./code-hosting";
import { prPreviewEnabled } from "./env";
import type { RepositoryRef } from "./code-hosting/types";
import { listIssueComments, getPullRequestFiles, upsertIssueComment } from "./github";
import type { GitHubAccess } from "./github-access";
import type { PrPreviewJob } from "./github-webhook";

export interface AffectedSpecEntry {
  featureName: string;
  scenarioReference: string | null;
  path: string;
}

export function prPreviewCommentMarker(owner: string, name: string, number: number) {
  return `<!-- codelphi-pr-preview:${owner}/${name}#${number} -->`;
}

const referenceOrder: Record<string, number> = { HP: 0, EC: 1, ER: 2 };

/** 场景编号按 正常→边界→错误 语义排序，而非字母序。 */
function sortReferences(references: Set<string>) {
  return [...references].sort((a, b) => {
    const [prefixA, numA] = a.split("-");
    const [prefixB, numB] = b.split("-");
    const orderA = referenceOrder[prefixA] ?? 9;
    const orderB = referenceOrder[prefixB] ?? 9;
    return orderA !== orderB ? orderA - orderB : Number(numA) - Number(numB);
  });
}

/** 渲染 PR 预演评论：按功能分组的场景编号与证据路径；marker 行用于原地更新去重。 */
export function renderPrPreview(entries: AffectedSpecEntry[], fileCount: number, fullName: string, number: number): string {
  const byFeature = new Map<string, { references: Set<string>; paths: Set<string> }>();
  for (const entry of entries) {
    const group = byFeature.get(entry.featureName) ?? { references: new Set<string>(), paths: new Set<string>() };
    if (entry.scenarioReference) group.references.add(entry.scenarioReference);
    group.paths.add(entry.path);
    byFeature.set(entry.featureName, group);
  }
  const lines = [...byFeature.entries()].map(([featureName, group]) => {
    const references = sortReferences(group.references);
    const paths = [...group.paths].sort().map((path) => `\`${path}\``);
    const scenarioPart = references.length > 0 ? `场景 ${references.join("、")}（${paths.join("、")}）` : paths.join("、");
    return `- **${featureName}**：${scenarioPart}`;
  });
  return [
    `<!-- codelphi-pr-preview:${fullName}#${number} -->`,
    "## 🔭 CoDelphi 规格预演",
    "",
    `此 PR 触碰 ${fileCount} 个文件，涉及 ${byFeature.size} 个功能（基于最近一次成功分析的规格索引）：`,
    "",
    ...lines,
    "",
    "_预演基于历史分析，非本 PR 合并结果；合并后以实际分析为准。_",
  ].join("\n");
}

interface PreviewTarget {
  provider?: string;
  defaultBranch: string;
  connectionId: number | null;
  organizationId: number;
}

async function loadPreviewTarget(repositoryId: number): Promise<PreviewTarget | undefined> {
  const [rows] = await getDb().execute(
    `SELECT repo.provider, repo.default_branch AS defaultBranch, repo.connection_id AS connectionId, p.organization_id AS organizationId
     FROM repositories repo JOIN products p ON p.id = repo.product_id WHERE repo.id = ?`,
    [repositoryId],
  );
  return ((rows as PreviewTarget[])[0]);
}

async function loadAffectedEntries(repositoryId: number, paths: string[]): Promise<AffectedSpecEntry[]> {
  const placeholders = paths.map(() => "?").join(",");
  const [rows] = await getDb().execute(
    `SELECT sf.name AS featureName, ss.reference AS scenarioReference, i.path
     FROM spec_file_index i
     JOIN spec_features sf ON sf.id = i.spec_feature_id
     LEFT JOIN spec_scenarios ss ON ss.id = i.spec_scenario_id
     WHERE i.repository_id = ? AND i.path IN (${placeholders})`,
    [repositoryId, ...paths],
  );
  return rows as AffectedSpecEntry[];
}

/**
 * PR 预演：触碰文件 ∩ 规格索引 → 在 PR 里原地更新预演评论。
 * 全程吞错（after() 上下文里失败只记日志），未开启开关或无交集时静默。
 */
export async function runPrPreview(job: PrPreviewJob) {
  if (!prPreviewEnabled()) return;
  try {
    const target = await loadPreviewTarget(job.repositoryId);
    if (!target) return;
    const adapter = getCodeHostingAdapter(target.provider ?? "github");
    if (!adapter.getPullRequestFiles || !adapter.listIssueComments || !adapter.upsertIssueComment) return;

    const repository: RepositoryRef = { owner: job.owner, name: job.name, defaultBranch: target.defaultBranch };
    const access: GitHubAccess = { connectionId: target.connectionId, organizationId: target.organizationId };
    const files = await adapter.getPullRequestFiles(repository, job.number, access);
    const paths = [...new Set(files.map((file) => file.path))];
    if (paths.length === 0) return;

    const affected = await loadAffectedEntries(job.repositoryId, paths);
    if (affected.length === 0) return;

    const body = renderPrPreview(affected, paths.length, `${job.owner}/${job.name}`, job.number);
    const comments = await adapter.listIssueComments(repository, job.number, access);
    const existing = comments.find((comment) => comment.body.includes(prPreviewCommentMarker(job.owner, job.name, job.number)));
    await adapter.upsertIssueComment(repository, job.number, body, existing?.id ?? null, access);
  } catch (error) {
    console.error("[pr-preview] failed", error);
  }
}
