"use client";

import { useState } from "react";
import { ReleaseCard } from "./release-card";
import { loadMoreReleases } from "@/lib/release-client";
import type { RegressionTaskView } from "@/lib/regression-task-view";
import { errorMessage } from "@/lib/error-message";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { PRODUCT_CHANGES as L } from "@/lib/ui-strings/product";
import type { BehaviorChangeRow, ChangeRow, FoldedBehaviorChangeRow, ReleaseRow } from "@/lib/types";

export function ProductChanges({ slug, releases: initialReleases, changes: initialChanges, reviewedChanges: initialReviewedChanges = [], behaviorChanges: initialBehaviorChanges, foldedChanges: initialFoldedChanges = [], regressionTasks: initialRegressionTasks = [], releaseTotal = 0, canEdit = false, changelogHref, locale = "zh-CN" }: {
  changelogHref?: string;
  slug: string;
  releases: ReleaseRow[];
  changes: ChangeRow[];
  reviewedChanges?: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  foldedChanges?: FoldedBehaviorChangeRow[];
  regressionTasks?: RegressionTaskView[];
  releaseTotal?: number;
  canEdit?: boolean;
  locale?: UiLocale;
}) {
  const [releases, setReleases] = useState(initialReleases);
  const [changes, setChanges] = useState(initialChanges);
  const [reviewedChanges, setReviewedChanges] = useState(initialReviewedChanges);
  const [behaviorChanges, setBehaviorChanges] = useState(initialBehaviorChanges);
  const [foldedChanges, setFoldedChanges] = useState(initialFoldedChanges);
  const [regressionTasks, setRegressionTasks] = useState(initialRegressionTasks);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const hasMore = releases.length < releaseTotal;

  const loadMore = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      const page = await loadMoreReleases(slug, releases.length);
      setReleases((current) => [...current, ...page.releases]);
      setChanges((current) => [...current, ...page.changes]);
      setReviewedChanges((current) => [...current, ...page.reviewedChanges]);
      setBehaviorChanges((current) => [...current, ...page.behaviorChanges]);
      setFoldedChanges((current) => [...current, ...page.foldedChanges]);
      setRegressionTasks((current) => [...current, ...(page.regressionTasks ?? [])]);
    } catch (cause: unknown) {
      setError(errorMessage(cause, pick(locale, L.loadError)));
    } finally {
      setLoading(false);
    }
  };

  if (releases.length === 0) {
    return <div className="empty-state"><strong>{pick(locale, L.emptyTitle)}</strong><p>{pick(locale, L.emptyBody)}</p></div>;
  }

  return (
    <div className="release-list">
      <div className="release-list-head">
        <a className="overview-text-link" href={`/api/products/${slug}/progress-summary?days=30`}>{pick(locale, L.exportIndex)}</a>
      </div>
      {releases.map((release) => <ReleaseCard
        slug={slug}
        release={release}
        changes={changes.filter((change) => change.releaseId === release.id)}
        reviewedChanges={reviewedChanges.filter((change) => change.releaseId === release.id)}
        behaviorChanges={behaviorChanges.filter((change) => change.releaseId === release.id)}
        foldedChanges={foldedChanges.filter((change) => change.releaseId === release.id)}
        tasks={regressionTasks.filter((task) => task.releaseId === release.id)}
        canEdit={canEdit}
        changelogHref={changelogHref}
        locale={locale}
        key={release.id}
      />)}
      {hasMore ? (
        <div className="release-load-more">
          <button className="secondary-button" type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? pick(locale, L.loading) : pick(locale, L.loadMore).replace("{count}", String(releaseTotal - releases.length))}
          </button>
        </div>
      ) : null}
      {error ? <p className="overview-error" role="alert">{error}</p> : null}
    </div>
  );
}
