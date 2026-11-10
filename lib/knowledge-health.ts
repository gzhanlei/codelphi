import type { RegressionTaskView } from "./regression-task-view";

/**
 * P2 知识健康第一版（product-capability-maturity-roadmap.md §P2）：只展示事实性统计，
 * 不做综合健康分数（分母口径不成立）、不做 Bus Factor（维护记录 ≠ 掌握知识）。
 * 数据源全部为已持久化事实：stale 标记、核实时间戳、回归任务四态、编辑归因（migration 064）。
 */

export interface KnowledgeHealthReport {
  /** 漂移条目数（功能+场景，stale_since 非空）。 */
  staleCount: number;
  staleItems: Array<{ kind: "feature" | "scenario"; name: string; reference: string; staleSince: string }>;
  /** 已核实条目数（当前版本 verified_at 非空）。 */
  verifiedCount: number;
  totalItems: number;
  latestVerifiedAt: string | null;
  /** 最新发布的回归任务四态计数。 */
  regression: { total: number; passed: number; failed: number; skipped: number; pending: number };
  /** 编辑归因分布（近 windowDays 天，按编辑者计数；未归因的历史编辑不计入推断）。 */
  maintenance: Array<{ editor: string; edits: number }>;
  maintenanceWindowDays: number;
  unattributedEdits: number;
}

const KIND_LABEL: Record<string, string> = { happy: "HP", edge: "EC", error: "ER" };

export function buildKnowledgeHealth(input: {
  features: Array<{ id: number; name: string; staleSince?: Date | string | null; verifiedAt?: Date | string | null; lastEditedBy?: string | null; lastEditedAt?: Date | string | null }>;
  scenarios: Array<{ id: number; featureId: number; reference: string; staleSince?: Date | string | null; verifiedAt?: Date | string | null; lastEditedBy?: string | null; lastEditedAt?: Date | string | null }>;
  regressionTasks: RegressionTaskView[];
  latestReleaseId?: number;
  now?: Date;
  maintenanceWindowDays?: number;
}): KnowledgeHealthReport {
  const features = input.features;
  const scenarios = input.scenarios;
  const staleItems = [
    ...features.filter((feature) => feature.staleSince).map((feature) => ({ kind: "feature" as const, name: feature.name, reference: "", staleSince: new Date(feature.staleSince as string | Date).toISOString() })),
    ...scenarios
      .filter((scenario) => scenario.staleSince)
      .map((scenario) => {
        const feature = features.find((candidate) => candidate.id === scenario.featureId);
        return { kind: "scenario" as const, name: feature?.name ?? "", reference: scenario.reference, staleSince: new Date(scenario.staleSince as string | Date).toISOString() };
      }),
  ].sort((a, b) => a.staleSince.localeCompare(b.staleSince));

  const verifiedCount = features.filter((feature) => feature.verifiedAt).length + scenarios.filter((scenario) => scenario.verifiedAt).length;
  const latestVerifiedAt = [...features, ...scenarios]
    .map((item) => item.verifiedAt)
    .filter((value): value is string | Date => Boolean(value))
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;

  const regression = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const task of input.regressionTasks) {
    if (input.latestReleaseId !== undefined && task.releaseId !== input.latestReleaseId) continue;
    regression.total += 1;
    regression[task.status] += 1;
  }

  const windowDays = input.maintenanceWindowDays ?? 90;
  const cutoff = (input.now ?? new Date()).getTime() - windowDays * 24 * 3600 * 1000;
  const editsBy = new Map<string, number>();
  let unattributedEdits = 0;
  for (const item of [...features, ...scenarios]) {
    if (!item.lastEditedAt) continue;
    if (new Date(item.lastEditedAt).getTime() < cutoff) continue;
    if (item.lastEditedBy) {
      editsBy.set(item.lastEditedBy, (editsBy.get(item.lastEditedBy) ?? 0) + 1);
    } else {
      unattributedEdits += 1;
    }
  }

  return {
    staleCount: staleItems.length,
    staleItems: staleItems.slice(0, 10),
    verifiedCount,
    totalItems: features.length + scenarios.length,
    latestVerifiedAt: latestVerifiedAt ? new Date(latestVerifiedAt).toISOString() : null,
    regression,
    maintenance: [...editsBy.entries()].map(([editor, edits]) => ({ editor, edits })).sort((a, b) => b.edits - a.edits),
    maintenanceWindowDays: windowDays,
    unattributedEdits,
  };
}
