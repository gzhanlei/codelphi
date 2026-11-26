"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { RELEASE_CARD } from "@/lib/ui-strings/product";
import { formatDateIn } from "@/lib/format";
import type { BehaviorChangeRow, ChangeRow, FoldedBehaviorChangeRow, ReleaseRow } from "@/lib/types";
import { hitTypeLabel, regressionStatusLabel, type RegressionTaskStatus, type RegressionTaskView } from "@/lib/regression-task-view";
import { errorMessage } from "@/lib/error-message";
import { BehaviorChangeItem } from "./behavior-change-item";
import { ChangeItem } from "./change-item";
import { ReleaseNotesPanel } from "./release-notes-panel";
import { useDemoGuard } from "./demo-mode";

function QuietRelease({ specVersionId, locale = "zh-CN" }: { specVersionId: number | null; locale?: UiLocale }) {
  return specVersionId
    ? <p className="quiet-release">{pick(locale, RELEASE_CARD.quietRelease)}</p>
    : null;
}

function ReasonTags({ task, locale = "zh-CN" }: { task: RegressionTaskView; locale?: UiLocale }) {
  const tags = task.reasons.filter((reason) => reason.hitType !== "behavior_change");
  const extra = task.sources.length > 1 ? [<span className="regression-reason" key="sources">{pick(locale, RELEASE_CARD.fromChanges).replace("{count}", String(task.sources.length))}</span>] : [];
  if (tags.length === 0 && extra.length === 0) return null;
  return (
    <span className="regression-reasons">
      {extra}
      {tags.map((reason, index) => (
        <span className="regression-reason" key={index} title={reason.matchedPath ?? undefined}>
          {hitTypeLabel(reason.hitType, locale)}
          {reason.matchedPath ? <code>{reason.matchedPath}</code> : null}
        </span>
      ))}
    </span>
  );
}

function RegressionChecklist({ slug, release, changes, tasks, canEdit, locale = "zh-CN" }: {
  slug: string;
  release: ReleaseRow;
  changes: BehaviorChangeRow[];
  tasks: RegressionTaskView[];
  canEdit: boolean;
  locale?: UiLocale;
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
        throw new Error(data.error ?? pick(locale, RELEASE_CARD.saveFailed));
      }
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, pick(locale, RELEASE_CARD.saveFailed)));
    }
  };

  const changeById = new Map(changes.map((change) => [change.id, change]));
  const byFeature = new Map<string, RegressionTaskView[]>();
  for (const task of tasks) {
    const list = byFeature.get(task.featureName) ?? [];
    list.push(task);
    byFeature.set(task.featureName, list);
  }

  const statuses: RegressionTaskStatus[] = ["pending", "passed", "failed", "skipped"];

  return (
    <div className="behavior-section regression-section">
      <h3>
        {pick(locale, RELEASE_CARD.regressionHeading)}
        <a className="overview-text-link" href={`/api/products/${slug}/releases/${release.id}/regression`}>{pick(locale, RELEASE_CARD.exportMarkdown)}</a>
      </h3>
      {[...byFeature.entries()].map(([featureName, featureTasks]) => (
        <div className="regression-feature" key={featureName}>
          <h4>{featureName}</h4>
          {featureTasks.map((task) => {
            const primary = task.primaryChangeId !== null ? changeById.get(task.primaryChangeId) : undefined;
            const subjectRef = task.reference ?? pick(locale, RELEASE_CARD.scenarioRef).replace("{id}", String(task.subject.kind === "scenario" ? task.subject.scenarioId : ""));
            return (
              <div className="regression-item" key={task.taskId}>
                {primary ? <BehaviorChangeItem change={primary} /> : (
                  <div className="change-item">
                    <strong>{subjectRef}</strong>
                    <span className="regression-impact-hint">{pick(locale, RELEASE_CARD.impactHint)}</span>
                  </div>
                )}
                <div className="regression-controls">
                  <ReasonTags task={task} locale={locale} />
                  <select
                    aria-label={pick(locale, RELEASE_CARD.statusAria).replace("{feature}", featureName).replace("{reference}", task.reference ?? "")}
                    className={`regression-status ${task.status}`}
                    value={task.status}
                    disabled={!canEdit}
                    onChange={(event) => void save(task.taskId, event.target.value as RegressionTaskStatus)}
                  >
                    {statuses.map((value) => (
                      <option key={value} value={value}>{regressionStatusLabel(value, locale)}</option>
                    ))}
                  </select>
                  {canEdit && task.status === "skipped" ? (
                    <input
                      className="regression-note"
                      placeholder={pick(locale, RELEASE_CARD.skipPlaceholder)}
                      defaultValue={task.skipReason ?? ""}
                      aria-label={pick(locale, RELEASE_CARD.skipAria).replace("{feature}", featureName).replace("{reference}", task.reference ?? "")}
                      onBlur={(event) => {
                        if ((task.skipReason ?? "") !== event.target.value) void save(task.taskId, "skipped", event.target.value);
                      }}
                    />
                  ) : null}
                  {canEdit && task.status === "failed" ? (
                    <input
                      className="regression-note"
                      placeholder={pick(locale, RELEASE_CARD.failPlaceholder)}
                      defaultValue={task.failureNote ?? ""}
                      aria-label={pick(locale, RELEASE_CARD.failAria).replace("{feature}", featureName).replace("{reference}", task.reference ?? "")}
                      onBlur={(event) => {
                        if ((task.failureNote ?? "") !== event.target.value) void save(task.taskId, "failed", event.target.value);
                      }}
                    />
                  ) : null}
                  {task.status !== "pending" && task.checkedBy ? <span className="regression-checked-by">{pick(locale, RELEASE_CARD.markedBy).replace("{name}", task.checkedBy)}</span> : null}
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

function BehaviorList({ slug, release, changes, tasks, canEdit, locale = "zh-CN" }: {
  slug: string;
  release: ReleaseRow;
  changes: BehaviorChangeRow[];
  tasks: RegressionTaskView[];
  canEdit: boolean;
  locale?: UiLocale;
}) {
  if (tasks.length === 0) return <QuietRelease specVersionId={release.specVersionId} locale={locale} />;
  return <RegressionChecklist slug={slug} release={release} changes={changes} tasks={tasks} canEdit={canEdit} locale={locale} />;
}

function AiChangeList({ changes, locale = "zh-CN" }: { changes: ChangeRow[]; locale?: UiLocale }) {
  if (changes.length === 0) return null;
  return <div className="ai-change-section"><h3>{pick(locale, RELEASE_CARD.aiChangeHeading)}</h3>{changes.map((change) => <ChangeItem change={change} key={change.id} />)}</div>;
}

export function ReleaseCard({ slug, release, changes, reviewedChanges = [], behaviorChanges, foldedChanges = [], tasks = [], canEdit = false, changelogHref, defaultOpen = false, locale = "zh-CN" }: {
  changelogHref?: string;
  slug: string;
  release: ReleaseRow;
  changes: ChangeRow[];
  reviewedChanges?: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  foldedChanges?: FoldedBehaviorChangeRow[];
  tasks?: RegressionTaskView[];
  canEdit?: boolean;
  defaultOpen?: boolean;
  locale?: UiLocale;
}) {
  const releaseChanges = changes.filter((change) => change.releaseId === release.id);
  const releaseReviewedChanges = reviewedChanges.filter((change) => change.releaseId === release.id);
  // 深链定位（总览 CTA「去校对并发布」）：命中 #release-{id} 时自动展开并滚动到卡片
  const [openByHash, setOpenByHash] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (window.location.hash === `#release-${release.id}`) {
      setOpenByHash(true);
      sectionRef.current?.scrollIntoView({ block: "start" });
    }
  }, [release.id]);
  const releaseBehaviorChanges = behaviorChanges.filter((change) => change.releaseId === release.id);
  const releaseFolded = foldedChanges.filter((change) => change.releaseId === release.id);
  const releaseTasks = tasks.filter((task) => task.releaseId === release.id);
  const hasDetails = releaseBehaviorChanges.length > 0 || releaseChanges.length > 0 || releaseReviewedChanges.length > 0;
  return (
    <section className="release-card" id={`release-${release.id}`} ref={sectionRef}>
      <div className="release-header">
        <div>
          <time>{formatDateIn(locale, release.committedAt, { dateStyle: "long" })}</time><h2>{release.title}</h2>
          {release.provenance
            ? <span className="release-provenance">{"entry" in release.provenance ? pick(locale, RELEASE_CARD.importedSnapshot) : pick(locale, RELEASE_CARD.clientAnalysis).replace("{model}", release.provenance.model)}</span>
            : null}
        </div>
        {/* 仓库只存在于租户自己的机器上时没有可以点开的地址，就不放链接。 */}
        {release.url
          ? <a href={release.url} target="_blank" rel="noreferrer"><code>{release.sha.slice(0, 7)}</code> ↗</a>
          : <code>{release.sha.slice(0, 7)}</code>}
      </div>
      <p className="release-summary">{release.summary}</p>
      {hasDetails ? (
        <details className="release-details" open={defaultOpen || openByHash}>
          <summary>
            <span>{pick(locale, RELEASE_CARD.detailsSummary).replace("{behavior}", String(releaseBehaviorChanges.length)).replace("{notes}", String(releaseChanges.length + releaseReviewedChanges.length))}</span>
            <span className="release-details-toggle">{defaultOpen ? pick(locale, RELEASE_CARD.collapse) : pick(locale, RELEASE_CARD.expand)}</span>
          </summary>
          <BehaviorList slug={slug} release={release} changes={releaseBehaviorChanges} tasks={releaseTasks} canEdit={canEdit} locale={locale} />
          <AiChangeList changes={[...releaseChanges, ...releaseReviewedChanges]} locale={locale} />
          <ReleaseNotesPanel slug={slug} releaseId={release.id} canEdit={canEdit} changelogHref={changelogHref} locale={locale} />
        </details>
      ) : (
        <BehaviorList slug={slug} release={release} changes={releaseBehaviorChanges} tasks={releaseTasks} canEdit={canEdit} locale={locale} />
      )}
      {releaseFolded.length > 0 ? (
        <details className="release-details folded-changes">
          <summary>
            <span>{pick(locale, RELEASE_CARD.foldedSummary).replace("{count}", String(releaseFolded.length))}</span>
            <span className="release-details-toggle">{pick(locale, RELEASE_CARD.expand)}</span>
          </summary>
          {releaseFolded.map((change) => <BehaviorChangeItem change={change} key={change.id} />)}
        </details>
      ) : null}
    </section>
  );
}
