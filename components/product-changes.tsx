import { ReleaseCard } from "./release-card";
import type { RegressionStatusMap } from "@/lib/regression-view";
import type { BehaviorChangeRow, ChangeRow, ReleaseRow } from "@/lib/types";

export function ProductChanges({ slug, releases, changes, behaviorChanges, regressionStatuses = {}, canEdit = false }: {
  slug: string;
  releases: ReleaseRow[];
  changes: ChangeRow[];
  behaviorChanges: BehaviorChangeRow[];
  regressionStatuses?: RegressionStatusMap;
  canEdit?: boolean;
}) {
  if (releases.length === 0) {
    return <div className="empty-state"><strong>还没有发布记录</strong><p>GitHub push 或手动分析后，这里会显示产品变化。</p></div>;
  }

  return (
    <div className="release-list">
      {releases.map((release) => <ReleaseCard slug={slug} release={release} changes={changes} behaviorChanges={behaviorChanges} statuses={regressionStatuses} canEdit={canEdit} key={release.id} />)}
    </div>
  );
}
