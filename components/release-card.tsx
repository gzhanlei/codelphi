"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BehaviorChangeRow, ChangeRow, FoldedBehaviorChangeRow, ReleaseRow } from "@/lib/types";
import { hitTypeLabels, regressionStatusLabels, type RegressionTaskStatus, type RegressionTaskView } from "@/lib/regression-task-view";
import { errorMessage } from "@/lib/error-message";
import { BehaviorChangeItem } from "./behavior-change-item";
import { ChangeItem } from "./change-item";
import { ReleaseNotesPanel } from "./release-notes-panel";
import { useDemoGuard } from "./demo-mode";

function QuietRelease({ specVersionId }: { specVersionId: number | null }) {
  return specVersionId
    ? <p className="quiet-release">本次分析未发现规格行为变化，无需全量回归；建议做瘦身回归——按近期风险抽查核心路径与既有冒烟用例即可。</p>
    : null;
}

function ReasonTags({ task }: { task: RegressionTaskView }) {
  const tags = task.reasons.filter((reason) => reason.hitType !== "behavior_change");
  const extra = task.sources.length > 1 ? [<span className="regression-reason" key="sources">来自 {task.sources.length} 条变化</span>] : [];
  if (tags.length === 0 && extra.length === 0) return null;
  return (
    <span className="regression-reasons">
      {extra}
      {tags.map((reason, index) => (
        <span className="regression-reason" key={index} title={reason.matchedPath ?? undefined}>
          {hitTypeLabels[reason.hitType]}
          {reason.matchedPath ? <code>{reason.matchedPath}</code> : null}
        </span>
      ))}
    </span>
  );
}

function RegressionChecklist({ slug, release, changes, tasks, canEdit }: {
  slug: string;
  release: ReleaseRow;
  changes: BehaviorChangeRow[];
  tasks: RegressionTaskView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [error, setError] = useState("");

  const save = async (taskId: number, status: RegressionTaskStatus, note?: string) => {
    if (guard()) return;
    setError("");
    try {
      const response = await fetch(`/api/products/${slug}/regression-tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          releaseId: release.id,
          taskId,
          status,
          ...(status === "skipped" && note !== undefined ? { skipReason: note } : {}),
          ...(status === "failed" && note !== undefined ? { failureNote: note } : {}),
        }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "保存验证状态失败");
      }
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存验证状态失败"));
    }
  };

  const changeById = new Map(changes.map((change) => [change.id, change]));
  const byFeature = new Map<string, RegressionTaskView[]>();
  for (const task of tasks) {
    const list = byFeature.get(task.featureName) ?? [];
    list.push(task);
    byFeature.set(task.featureName, list);
  }

  return (
    <div className="behavior-section regression-section">
      <h3>
        回归清单
        <a className="overview-text-link" href={`/api/products/${slug}/releases/${release.id}/regression`}>导出 Markdown ↓</a>
      </h3>
      {[...byFeature.entries()].map(([featureName, featureTasks]) => (
        <div className="regression-feature" key={featureName}>
          <h4>{featureName}</h4>
          {featureTasks.map((task) => {
            const primary = task.primaryChangeId !== null ? changeById.get(task.primaryChangeId) : undefined;
            return (
              <div className="regression-item" key={task.taskId}>
                {primary ? <BehaviorChangeItem change={primary} /> : (
                  <div className="change-item">
                    <strong>{task.reference ?? `场景 ${task.subject.kind === "scenario" ? task.subject.scenarioId : ""}`}</strong>
                    <span className="regression-impact-hint">影响面推荐 · 证据路径与本次改动文件命中</span>
                  </div>
                )}
                <div className="regression-controls">
                  <ReasonTags task={task} />
                  <select
                    aria-label={`回归状态：${task.featureName} ${task.reference ?? ""}`}
                    className={`regression-status ${task.status}`}
                    value={task.status}
                    disabled={!canEdit}
                    onChange={(event) => void save(task.taskId, event.target.value as RegressionTaskStatus)}
                  >
                    {(Object.keys(regressionStatusLabels) as RegressionTaskStatus[]).map((value) => (
                      <option key={value} value={value}>{regressionStatusLabels[value]}</option>
                    ))}
                  </select>
                  {canEdit && task.status === "skipped" ? (
                    <input
                      className="regression-note"
                      placeholder="跳过原因（可选）"
                      defaultValue={task.skipReason ?? ""}
                      aria-label={`跳过原因：${task.featureName} ${task.reference ?? ""}`}
                      onBlur={(event) => {
                        if ((task.skipReason ?? "") !== event.target.value) void save(task.taskId, "skipped", event.target.value);
                      }}
                    />
                  ) : null}
                  {canEdit && task.status === "failed" ? (
                    <input
                      className="regression-note"
                      placeholder="发现的问题 / 关联缺陷（可选）"
                      defaultValue={task.failureNote ?? ""}
                      aria-label={`失败备注：${task.featureName} ${task.reference ?? ""}`}
                      onBlur={(event) => {
                        if ((task.failureNote ?? "") !== event.target.value) void save(task.taskId, "failed", event.target.value);
                      }}
                    />
                  ) : null}
                  {task.status !== "pending" && task.checkedBy ? <span className="regression-checked-by">由 {task.checkedBy} 标记</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}

function BehaviorList({ slug, release, changes, tasks, canEdit }: {
  slug: string;
  release: ReleaseRow;
  changes: BehaviorChangeRow[];
  tasks: RegressionTaskView[];
  canEdit: boolean;
}) {
  if (tasks.length === 0) return <QuietRelease specVersionId={release.specVersionId} />;
  return <RegressionChecklist slug={slug} release={release} changes={changes} tasks={tasks} canEdit={canEdit} />;
}

function AiChangeList({ changes }: { changes: ChangeRow[] }) {
  if (changes.length === 0) return null;
  return <div className="ai-change-section"><h3>变更说明（AI）</h3>{changes.map((change) => <ChangeItem change={change} key={change.id} />)}</div>;
}

export function ReleaseCard({ slug, release, changes, behaviorChanges, foldedChanges = [], tasks = [], canEdit = false, defaultOpen = false }: {
  slug: string;
  release: ReleaseRow;
  changes: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  foldedChanges?: FoldedBehaviorChangeRow[];
  tasks?: RegressionTaskView[];
  canEdit?: boolean;
  defaultOpen?: boolean;
}) {
  const releaseChanges = changes.filter((change) => change.releaseId === release.id);
  const releaseBehaviorChanges = behaviorChanges.filter((change) => change.releaseId === release.id);
  const releaseFolded = foldedChanges.filter((change) => change.releaseId === release.id);
  const releaseTasks = tasks.filter((task) => task.releaseId === release.id);
  const hasDetails = releaseBehaviorChanges.length > 0 || releaseChanges.length > 0;
  return (
    <section className="release-card">
      <div className="release-header">
        <div><time>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date(release.committedAt))}</time><h2>{release.title}</h2></div>
        <a href={release.url} target="_blank" rel="noreferrer"><code>{release.sha.slice(0, 7)}</code> ↗</a>
      </div>
      <p className="release-summary">{release.summary}</p>
      {hasDetails ? (
        <details className="release-details" open={defaultOpen}>
          <summary>
            <span>行为变化 {releaseBehaviorChanges.length} 条 · 变更说明 {releaseChanges.length} 条</span>
            <span className="release-details-toggle">{defaultOpen ? "收起" : "展开"}</span>
          </summary>
          <BehaviorList slug={slug} release={release} changes={releaseBehaviorChanges} tasks={releaseTasks} canEdit={canEdit} />
          <AiChangeList changes={releaseChanges} />
          <ReleaseNotesPanel slug={slug} releaseId={release.id} canEdit={canEdit} />
        </details>
      ) : (
        <BehaviorList slug={slug} release={release} changes={releaseBehaviorChanges} tasks={releaseTasks} canEdit={canEdit} />
      )}
      {releaseFolded.length > 0 ? (
        <details className="release-details folded-changes">
          <summary>
            <span>另有 {releaseFolded.length} 条差异判定为仅措辞/编号调整，已折叠（未计入行为变化）</span>
            <span className="release-details-toggle">展开</span>
          </summary>
          {releaseFolded.map((change) => <BehaviorChangeItem change={change} key={change.id} />)}
        </details>
      ) : null}
    </section>
  );
}
