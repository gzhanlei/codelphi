"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BehaviorChangeRow, ChangeRow, ReleaseRow } from "@/lib/types";
import { regressionStatusLabels, regressionStatusKey, type RegressionStatus, type RegressionStatusMap } from "@/lib/regression-view";
import { errorMessage } from "@/lib/error-message";
import { BehaviorChangeItem } from "./behavior-change-item";
import { ChangeItem } from "./change-item";
import { useDemoGuard } from "./demo-mode";

function QuietRelease({ specVersionId }: { specVersionId: number | null }) {
  return specVersionId
    ? <p className="quiet-release">本次分析未发现规格行为变化，无需全量回归；建议做瘦身回归——按近期风险抽查核心路径与既有冒烟用例即可。</p>
    : null;
}

function RegressionChecklist({ slug, release, changes, statuses, canEdit }: {
  slug: string;
  release: ReleaseRow;
  changes: BehaviorChangeRow[];
  statuses: RegressionStatusMap;
  canEdit: boolean;
}) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [error, setError] = useState("");

  const setStatus = async (specChangeId: number, status: RegressionStatus) => {
    if (guard()) return;
    setError("");
    try {
      const response = await fetch(`/api/products/${slug}/regression-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ releaseId: release.id, specChangeId, status }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "保存勾选状态失败");
      }
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存勾选状态失败"));
    }
  };

  const byFeature = new Map<string, BehaviorChangeRow[]>();
  for (const change of changes) {
    const list = byFeature.get(change.featureName) ?? [];
    list.push(change);
    byFeature.set(change.featureName, list);
  }

  return (
    <div className="behavior-section regression-section">
      <h3>
        回归清单
        <a className="overview-text-link" href={`/api/products/${slug}/releases/${release.id}/regression`}>导出 Markdown ↓</a>
      </h3>
      {[...byFeature.entries()].map(([featureName, featureChanges]) => (
        <div className="regression-feature" key={featureName}>
          <h4>{featureName}</h4>
          {featureChanges.map((change) => {
            const status = statuses[regressionStatusKey(release.id, change.id)]?.status ?? "pending";
            return (
              <div className="regression-item" key={change.id}>
                <BehaviorChangeItem change={change} />
                <select
                  aria-label={`回归状态：${change.featureName} ${change.scenarioReference || change.summary}`}
                  className={`regression-status ${status}`}
                  value={status}
                  disabled={!canEdit}
                  onChange={(event) => void setStatus(change.id, event.target.value as RegressionStatus)}
                >
                  {(Object.keys(regressionStatusLabels) as RegressionStatus[]).map((value) => (
                    <option key={value} value={value}>{regressionStatusLabels[value]}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      ))}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}

function BehaviorList({ slug, release, changes, statuses, canEdit }: {
  slug: string;
  release: ReleaseRow;
  changes: BehaviorChangeRow[];
  statuses: RegressionStatusMap;
  canEdit: boolean;
}) {
  if (changes.length === 0) return <QuietRelease specVersionId={release.specVersionId} />;
  return <RegressionChecklist slug={slug} release={release} changes={changes} statuses={statuses} canEdit={canEdit} />;
}

function AiChangeList({ changes }: { changes: ChangeRow[] }) {
  if (changes.length === 0) return null;
  return <div className="ai-change-section"><h3>发布说明（AI）</h3>{changes.map((change) => <ChangeItem change={change} key={change.id} />)}</div>;
}

export function ReleaseCard({ slug, release, changes, behaviorChanges, statuses = {}, canEdit = false, defaultOpen = false }: {
  slug: string;
  release: ReleaseRow;
  changes: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  statuses?: RegressionStatusMap;
  canEdit?: boolean;
  defaultOpen?: boolean;
}) {
  const releaseChanges = changes.filter((change) => change.releaseId === release.id);
  const releaseBehaviorChanges = behaviorChanges.filter((change) => change.releaseId === release.id);
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
            <span>行为变化 {releaseBehaviorChanges.length} 条 · 发布说明 {releaseChanges.length} 条</span>
            <span className="release-details-toggle">{defaultOpen ? "收起" : "展开"}</span>
          </summary>
          <BehaviorList slug={slug} release={release} changes={releaseBehaviorChanges} statuses={statuses} canEdit={canEdit} />
          <AiChangeList changes={releaseChanges} />
        </details>
      ) : (
        <BehaviorList slug={slug} release={release} changes={releaseBehaviorChanges} statuses={statuses} canEdit={canEdit} />
      )}
    </section>
  );
}
