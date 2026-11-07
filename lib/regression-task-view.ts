import type { BehaviorChangeRow, ReleaseRow } from "./types";

/**
 * P0 场景级回归任务（基线文档「影响面 → 场景 → 回归联动」）：
 * 回归项 = 一次具体的场景验证任务，唯一粒度 (release, scenario)；
 * spec_change 作为变化来源多对多关联；推荐理由为可追溯关联记录。
 * 推荐是「推荐」：文件路径命中 ≠ 功能影响，理由必须随任务一起展示。
 */

export type RegressionTaskStatus = "pending" | "passed" | "failed" | "skipped";

export const regressionStatusLabels: Record<RegressionTaskStatus, string> = { pending: "待验证", passed: "已通过", failed: "未通过", skipped: "已跳过" };

export type RegressionHitType = "behavior_change" | "evidence_path" | "feature_wide";

export const hitTypeLabels: Record<RegressionHitType, string> = { behavior_change: "行为变化", evidence_path: "证据路径命中", feature_wide: "整功能受影响" };

export interface PlannedChange {
  id: number;
  entityType: "feature" | "scenario";
  kind: string;
  featureId: number;
  featureKey: string;
  featureName: string;
  scenarioReference: string;
  /** 该 change 指向的 spec_scenarios.id；仅 scenario 级 added/changed 有值。 */
  scenarioId: number | null;
}

export interface IndexHit {
  path: string;
  featureId: number;
  featureKey: string;
  featureName: string;
  scenarioId: number | null;
  reference: string | null;
}

export interface PlannedReason {
  hitType: RegressionHitType;
  matchedPath: string | null;
  featureId: number | null;
  scenarioId: number | null;
}

export type TaskSubject = { kind: "scenario"; scenarioId: number } | { kind: "change"; changeId: number };

export interface PlannedTask {
  subject: TaskSubject;
  sources: number[];
  reasons: PlannedReason[];
}

export interface RegressionTaskView {
  taskId: number;
  releaseId: number;
  subject: TaskSubject;
  status: RegressionTaskStatus;
  checkedBy: string | null;
  checkedAt: Date | null;
  skipReason: string | null;
  failureNote: string | null;
  featureName: string;
  reference: string | null;
  /** 直接行为变化来源的 spec_change id，用于复用行为变化卡片渲染；纯影响面推荐的任务为 null。 */
  primaryChangeId: number | null;
  sources: number[];
  reasons: PlannedReason[];
}

export interface FeatureScenario {
  scenarioId: number;
  reference: string;
}

function reasonKey(reason: PlannedReason) {
  return `${reason.hitType}:${reason.matchedPath ?? ""}:${reason.scenarioId ?? ""}`;
}

/**
 * 纯函数：由行为变化 + 发布改动文件的索引命中，规划场景级回归任务。
 * 同一场景的多个来源合并为一个任务；理由去重；输出顺序确定。
 */
export function planRegressionTasks(input: { changes: PlannedChange[]; fileHits: IndexHit[]; featureScenarios: Map<number, FeatureScenario[]> }): PlannedTask[] {
  const { changes, fileHits, featureScenarios } = input;
  const tasks = new Map<string, PlannedTask>();
  const reasons = new Map<string, Set<string>>();

  const task = (subject: TaskSubject): PlannedTask => {
    const key = subject.kind === "scenario" ? `s${subject.scenarioId}` : `c${subject.changeId}`;
    let value = tasks.get(key);
    if (!value) {
      value = { subject, sources: [], reasons: [] };
      tasks.set(key, value);
      reasons.set(key, new Set());
    }
    return value;
  };
  const addReason = (subject: TaskSubject, reason: PlannedReason) => {
    const key = subject.kind === "scenario" ? `s${subject.scenarioId}` : `c${subject.changeId}`;
    const marked = reasonKey(reason);
    if (reasons.get(key)?.has(marked)) return;
    task(subject);
    reasons.get(key)!.add(marked);
    tasks.get(key)!.reasons.push(reason);
  };

  for (const change of [...changes].sort((a, b) => a.id - b.id)) {
    if (change.entityType === "scenario" && change.kind !== "removed" && change.scenarioId !== null) {
      const subject: TaskSubject = { kind: "scenario", scenarioId: change.scenarioId };
      const value = task(subject);
      if (!value.sources.includes(change.id)) value.sources.push(change.id);
      addReason(subject, { hitType: "behavior_change", matchedPath: null, featureId: change.featureId, scenarioId: change.scenarioId });
    } else {
      const subject: TaskSubject = { kind: "change", changeId: change.id };
      const value = task(subject);
      if (!value.sources.includes(change.id)) value.sources.push(change.id);
      addReason(subject, { hitType: "behavior_change", matchedPath: null, featureId: change.featureId, scenarioId: change.scenarioId });
    }
  }

  for (const entry of [...fileHits].sort((a, b) => a.path.localeCompare(b.path) || (a.scenarioId ?? 0) - (b.scenarioId ?? 0))) {
    if (entry.scenarioId !== null) {
      addReason({ kind: "scenario", scenarioId: entry.scenarioId }, { hitType: "evidence_path", matchedPath: entry.path, featureId: entry.featureId, scenarioId: entry.scenarioId });
      continue;
    }
    for (const scenario of featureScenarios.get(entry.featureId) ?? []) {
      addReason({ kind: "scenario", scenarioId: scenario.scenarioId }, { hitType: "feature_wide", matchedPath: entry.path, featureId: entry.featureId, scenarioId: scenario.scenarioId });
    }
  }

  return [...tasks.values()];
}

const kindLabels: Record<string, string> = { added: "新增", changed: "变化", removed: "移除" };

function flatten(text: string) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function reasonSuffix(task: RegressionTaskView) {
  const parts: string[] = [];
  if (task.sources.length > 1) parts.push(`来自 ${task.sources.length} 条变化`);
  for (const reason of task.reasons) {
    if (reason.hitType === "behavior_change") parts.push("行为变化");
    else parts.push(`${hitTypeLabels[reason.hitType]} ${reason.matchedPath ?? ""}`.trim());
  }
  return parts.length ? `（${parts.join("；")}）` : "";
}

function taskSubjectText(task: RegressionTaskView, changeById: Map<number, BehaviorChangeRow>) {
  if (task.primaryChangeId !== null) {
    const change = changeById.get(task.primaryChangeId);
    if (change) {
      const kind = kindLabels[change.kind] ?? change.kind;
      const subject = change.entityType === "scenario" && change.scenarioReference ? `${change.scenarioReference} — ${flatten(change.summary)}` : flatten(change.summary);
      return `[${kind}] ${subject}`;
    }
  }
  if (task.subject.kind === "scenario") {
    return `[回归] ${task.reference ?? `场景 ${task.subject.scenarioId}`}（影响面推荐）`;
  }
  const change = changeById.get(task.subject.changeId);
  if (change) {
    const kind = kindLabels[change.kind] ?? change.kind;
    const subject = change.entityType === "scenario" && change.scenarioReference ? `${change.scenarioReference} — ${flatten(change.summary)}` : flatten(change.summary);
    return `[${kind}] ${subject}`;
  }
  return "[回归] 变化任务";
}

function statusSuffix(task: RegressionTaskView) {
  if (task.status === "pending") return "（待验证）";
  const label = regressionStatusLabels[task.status];
  const who = task.checkedBy ? ` @ ${task.checkedBy}` : "";
  if (task.status === "failed") return `（未通过${task.failureNote ? `：${task.failureNote}` : ""}${who}）`;
  if (task.status === "skipped") return `（已跳过${task.skipReason ? `：${task.skipReason}` : ""}${who}）`;
  return `（${label}${who}）`;
}

/** 发布回归清单的 Markdown 导出：场景级任务、理由与来源、四态勾选。 */
export function renderRegressionTaskMarkdown(input: { productName: string; release: ReleaseRow; changes: BehaviorChangeRow[]; tasks: RegressionTaskView[] }) {
  const { productName, release, changes, tasks } = input;
  const lines = [
    `# 回归清单 · ${release.title}`,
    "",
    `- 产品：${productName}`,
    `- 提交：[${release.sha.slice(0, 7)}](${release.url})`,
    `- 生成时间：${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
  ];
  if (tasks.length === 0) {
    lines.push("", "本次分析未发现规格行为变化，无需全量回归。建议做瘦身回归：按近期风险抽查核心路径与既有冒烟用例即可。");
    return lines.join("\n");
  }
  lines.push("");
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const byFeature = new Map<string, RegressionTaskView[]>();
  for (const task of tasks) {
    const list = byFeature.get(task.featureName) ?? [];
    list.push(task);
    byFeature.set(task.featureName, list);
  }
  for (const [featureName, featureTasks] of byFeature) {
    lines.push(`## ${featureName}`);
    for (const task of featureTasks) {
      const checked = task.status === "passed" ? "x" : " ";
      lines.push(`- [${checked}] ${taskSubjectText(task, changeById)}${reasonSuffix(task)}${statusSuffix(task)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}
