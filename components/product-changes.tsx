import { ChangeItem } from "./change-item";
import type { ChangeRow, ReleaseRow } from "@/lib/types";

export function ProductChanges({ releases, changes }: { releases: ReleaseRow[]; changes: ChangeRow[] }) {
  if (releases.length === 0) {
    return <div className="empty-state"><strong>还没有发布记录</strong><p>GitHub push 或手动分析后，这里会显示产品变化。</p></div>;
  }

  return (
    <div className="release-list">
      {releases.map((release) => (
        <section className="release-card" key={release.id}>
          <div className="release-header">
            <div><time>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(new Date(release.committedAt))}</time><h2>{release.title}</h2></div>
            <a href={release.url} target="_blank" rel="noreferrer"><code>{release.sha.slice(0, 7)}</code> ↗</a>
          </div>
          <p className="release-summary">{release.summary}</p>
          <div className="change-list">
            {changes.filter((change) => change.releaseId === release.id).map((change) => <ChangeItem change={change} key={change.id} />)}
          </div>
        </section>
      ))}
    </div>
  );
}
