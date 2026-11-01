import type { BehaviorChangeRow, ChangeRow, ReleaseRow } from "@/lib/types";
import { BehaviorChangeItem } from "./behavior-change-item";
import { ChangeItem } from "./change-item";

function QuietRelease({ specVersionId }: { specVersionId: number | null }) {
  return specVersionId ? <p className="quiet-release">本次分析未发现规格行为变化。</p> : null;
}

function BehaviorList({ release, changes }: { release: ReleaseRow; changes: BehaviorChangeRow[] }) {
  if (changes.length === 0) return <QuietRelease specVersionId={release.specVersionId} />;
  return <div className="behavior-section"><h3>规格行为变化</h3>{changes.map((change) => <BehaviorChangeItem change={change} key={change.id} />)}</div>;
}

function AiChangeList({ changes }: { changes: ChangeRow[] }) {
  if (changes.length === 0) return null;
  return <div className="ai-change-section"><h3>发布说明（AI）</h3>{changes.map((change) => <ChangeItem change={change} key={change.id} />)}</div>;
}

export function ReleaseCard({ release, changes, behaviorChanges }: { release: ReleaseRow; changes: ChangeRow[]; behaviorChanges: BehaviorChangeRow[] }) {
  const releaseChanges = changes.filter((change) => change.releaseId === release.id);
  const releaseBehaviorChanges = behaviorChanges.filter((change) => change.releaseId === release.id);
  return (
    <section className="release-card">
      <div className="release-header">
        <div><time>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date(release.committedAt))}</time><h2>{release.title}</h2></div>
        <a href={release.url} target="_blank" rel="noreferrer"><code>{release.sha.slice(0, 7)}</code> ↗</a>
      </div>
      <p className="release-summary">{release.summary}</p>
      <BehaviorList release={release} changes={releaseBehaviorChanges} />
      <AiChangeList changes={releaseChanges} />
    </section>
  );
}
