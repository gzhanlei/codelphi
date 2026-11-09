import { getCodeHostingAdapter, type CodeHostingAdapter, type CodeHostingProvider } from "./code-hosting";
import { queueAnalysis } from "./analysis";
import { defaultExecute, type Execute } from "./db";

/**
 * 按仓库的分析触发模式（定价校准：1 push = 1 SAU 的固定粒度让高频直推用户必然超额）：
 *   push        每次默认分支 push 立即分析（默认，保持现状）；
 *   daily       每天低峰期至多一次，当天有 push 才分析；
 *   push_count  每 N 次 push 立即分析，并由 daily sweep 当天兜底一次（先到先触发）。
 * 三种模式共享同一执行路径：触发时 queueAnalysis(before = 上次成功分析 SHA, after = 当前 HEAD)，
 * 一个 run 覆盖窗口内的全部 commit——分析层不感知触发模式。
 */

export type AnalysisTriggerMode = "push" | "daily" | "push_count";

export const DEFAULT_TRIGGER_N = 5;
export const DEFAULT_TRIGGER_HOUR = 3;

export type PushTriggerAction = "immediate" | "defer";

export interface PushTriggerInput {
  mode: AnalysisTriggerMode;
  /** 本 push 到达前的未处理 push 数（本 push 单独 +1）。 */
  pendingPushCount: number;
  /** 仓库是否已有成功的分析 run（首分析例外：任何模式都立即派发，接入即见规格）。 */
  hasSucceededAnalysis: boolean;
  triggerN: number | null;
}

export function resolvePushTriggerAction(input: PushTriggerInput): PushTriggerAction {
  if (!input.hasSucceededAnalysis) return "immediate";
  if (input.mode === "push") return "immediate";
  if (input.mode === "daily") return "defer";
  const threshold = input.triggerN ?? DEFAULT_TRIGGER_N;
  return input.pendingPushCount + 1 >= threshold ? "immediate" : "defer";
}

export const TRIGGER_SWEEP_LOCK = "analysis-trigger";

export interface TriggerSweepDependencies {
  execute?: Execute;
  queue?: typeof queueAnalysis;
  getAdapter?: (provider: CodeHostingProvider) => CodeHostingAdapter;
}

interface TriggerSweepRepository {
  repositoryId: number;
  provider: CodeHostingProvider;
  owner: string;
  name: string;
  defaultBranch: string;
  connectionId: number | null;
  organizationId: number;
}

export interface AnalysisTriggerSweepResult {
  analyzed: number;
  deferredSkip: number;
  noCommits: number;
  errors: string[];
}

/**
 * 触发兜底 sweep（每小时整点段运行，仓库按 analysis_trigger_hour 匹配小时，默认凌晨 3 点）：
 * 对 daily/push_count 模式且当天仍有未处理 push 的仓库，排队一次 before=上次成功水位 /
 * after=当前 HEAD 的累计分析。排队失败（如额度闸门）保留 pending，下小时重试——额度恢复后
 * 自动补上整个区间，不丢 commit。
 */
export async function runAnalysisTriggerSweepOnce(dependencies: TriggerSweepDependencies = {}): Promise<AnalysisTriggerSweepResult> {
  const execute = dependencies.execute ?? defaultExecute;
  const queue = dependencies.queue ?? queueAnalysis;
  const getAdapter = dependencies.getAdapter ?? getCodeHostingAdapter;
  const outcome: AnalysisTriggerSweepResult = { analyzed: 0, deferredSkip: 0, noCommits: 0, errors: [] };
  const [rows] = await execute(
    `SELECT r.id AS repositoryId, r.provider, r.owner, r.name, r.default_branch AS defaultBranch,
            r.connection_id AS connectionId, p.organization_id AS organizationId
     FROM repositories r JOIN products p ON p.id = r.product_id
     WHERE r.analysis_trigger IN ('daily', 'push_count') AND r.pending_push_count > 0
       AND HOUR(CURRENT_TIMESTAMP) = COALESCE(r.analysis_trigger_hour, ?)`,
    [DEFAULT_TRIGGER_HOUR],
  ) as [Array<{ repositoryId: number; provider: CodeHostingProvider; owner: string; name: string; defaultBranch: string; connectionId: number | null; organizationId: number }>, unknown];

  for (const repo of rows as TriggerSweepRepository[]) {
    const access = { connectionId: repo.connectionId, organizationId: repo.organizationId };
    try {
      const [runRows] = await execute(
        `SELECT after_sha AS afterSha FROM analysis_runs WHERE repository_id = ? AND status = 'succeeded' ORDER BY id DESC LIMIT 1`,
        [repo.repositoryId],
      ) as [Array<{ afterSha: string }>, unknown];
      const beforeSha = (runRows as Array<{ afterSha: string }>)[0]?.afterSha ?? null;
      const adapter = getAdapter(repo.provider);
      const metadata = await adapter.getRepository({ owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch }, access);
      const afterSha = await adapter.getBranchHead({ ...repo, ...metadata }, access);
      if (!beforeSha || !afterSha || beforeSha === afterSha) {
        outcome.noCommits += 1;
        await execute(`UPDATE repositories SET pending_push_count = 0 WHERE id = ?`, [repo.repositoryId]);
        continue;
      }
      await queue(repo.repositoryId, beforeSha, afterSha, "push");
      await execute(`UPDATE repositories SET pending_push_count = 0 WHERE id = ?`, [repo.repositoryId]);
      outcome.analyzed += 1;
    } catch (error) {
      // 单仓库失败不阻塞其他仓库；pending 保留，下小时重试（额度闸门拒绝 = 保留等待恢复）
      outcome.deferredSkip += 1;
      outcome.errors.push(`${repo.owner}/${repo.name}: ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`);
    }
  }
  return outcome;
}

/** 设置视图数据源：产品下各仓库的触发模式与未处理 push 计数。 */
export async function listProductRepositoryTriggers(productId: number, execute: Execute = defaultExecute) {
  const [rows] = await execute(
    `SELECT id, owner, name, analysis_trigger AS triggerMode, analysis_trigger_n AS n, analysis_trigger_hour AS hour,
            pending_push_count AS pendingPushCount
     FROM repositories WHERE product_id = ? ORDER BY id`,
    [productId],
  ) as [Array<{ id: number; owner: string; name: string; triggerMode: AnalysisTriggerMode; n: number | null; hour: number | null; pendingPushCount: number }>, unknown];
  return rows;
}

/** 工作区默认触发模式（migration 051）：新接入的仓库继承。 */
export interface WorkspaceTriggerDefault {
  trigger: AnalysisTriggerMode;
  n: number | null;
  hour: number | null;
}

export async function getWorkspaceTriggerDefault(organizationId: number, execute: Execute = defaultExecute): Promise<WorkspaceTriggerDefault> {
  const [rows] = await execute(
    `SELECT default_analysis_trigger AS triggerMode, default_analysis_trigger_n AS n, default_analysis_trigger_hour AS hour
     FROM organizations WHERE id = ? LIMIT 1`,
    [organizationId],
  ) as [Array<{ triggerMode: AnalysisTriggerMode; n: number | null; hour: number | null }>, unknown];
  const row = rows[0];
  return { trigger: row?.triggerMode ?? "push", n: row?.n ?? null, hour: row?.hour ?? null };
}

export async function updateWorkspaceTriggerDefault(organizationId: number, input: WorkspaceTriggerDefault, execute: Execute = defaultExecute) {
  await execute(
    `UPDATE organizations SET default_analysis_trigger = ?, default_analysis_trigger_n = ?, default_analysis_trigger_hour = ? WHERE id = ?`,
    [input.trigger, input.trigger === "push_count" ? input.n : null, input.trigger === "push" ? null : input.hour, organizationId],
  );
}
