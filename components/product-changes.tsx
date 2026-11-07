"use client";

import { useState } from "react";
import { ReleaseCard } from "./release-card";
import { loadMoreReleases } from "@/lib/release-client";
import type { RegressionTaskView } from "@/lib/regression-task-view";
import { errorMessage } from "@/lib/error-message";
import type { BehaviorChangeRow, ChangeRow, ReleaseRow } from "@/lib/types";

export function ProductChanges({ slug, releases: initialReleases, changes: initialChanges, behaviorChanges: initialBehaviorChanges, regressionTasks = [], releaseTotal = 0, canEdit = false }: {
  slug: string;
  releases: ReleaseRow[];
  changes: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  regressionTasks?: RegressionTaskView[];
  releaseTotal?: number;
  canEdit?: boolean;
}) {
  const [releases, setReleases] = useState(initialReleases);
  const [changes, setChanges] = useState(initialChanges);
  const [behaviorChanges, setBehaviorChanges] = useState(initialBehaviorChanges);
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
      setBehaviorChanges((current) => [...current, ...page.behaviorChanges]);
    } catch (cause: unknown) {
      setError(errorMessage(cause, "加载更多发布失败"));
    } finally {
      setLoading(false);
    }
  };

  if (releases.length === 0) {
    return <div className="empty-state"><strong>还没有发布记录</strong><p>GitHub push 或手动分析后，这里会显示产品变化。</p></div>;
  }

  return (
    <div className="release-list">
      <div className="release-list-head">
        <a className="overview-text-link" href={`/api/products/${slug}/progress-summary?days=30`}>导出进展摘要（30 天）↓</a>
      </div>
      {releases.map((release, index) => <ReleaseCard slug={slug} release={release} changes={changes} behaviorChanges={behaviorChanges} tasks={regressionTasks} canEdit={canEdit} defaultOpen={index === 0} key={release.id} />)}
      {hasMore ? (
        <div className="release-load-more">
          <button className="secondary-button" type="button" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "加载中…" : `加载更多（还有 ${releaseTotal - releases.length} 条）`}
          </button>
        </div>
      ) : null}
      {error ? <p className="overview-error" role="alert">{error}</p> : null}
    </div>
  );
}
