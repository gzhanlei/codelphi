import type { ChangeRow } from "@/lib/types";
import { EvidenceLinks } from "./evidence-links";

const kindLabels: Record<string, string> = { added: "新增", changed: "变化", removed: "移除", fixed: "修复", reviewed: "已检查" };

export function ChangeItem({ change }: { change: ChangeRow }) {
  return (
    <article className="change-item">
      <span className={`change-kind ${change.kind}`}>{kindLabels[change.kind]}</span>
      <div><span className="change-feature">{change.featureName}</span><p>{change.description}</p>{change.userImpact && <p className="user-impact">用户影响：{change.userImpact}</p>}<EvidenceLinks value={change.evidence} /></div>
    </article>
  );
}
