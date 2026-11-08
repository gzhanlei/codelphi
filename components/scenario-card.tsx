import type { ScenarioRow } from "@/lib/types";
import { scenarioCategoryLabel } from "@/lib/spec-editor-ui";
import { EvidenceLinks } from "./evidence-links";
import { VerifySpecButton } from "./verify-spec-button";

export function ScenarioCard({ slug, scenario, onEdit, onDelete }: { slug: string; scenario: ScenarioRow; onEdit: () => void; onDelete: () => void }) {
  return (
    <article className="scenario">
      <div className="scenario-label"><span className={`scenario-kind ${scenario.category}`}>{scenarioCategoryLabel(scenario.category)}</span><code>{scenario.reference}</code>{scenario.staleSince ? <span className="drift-badge">可能过时</span> : null}<span className="scenario-source">{scenario.source === "manual" ? "人工" : "生成"}</span><VerifySpecButton slug={slug} entityType="scenario" entityId={scenario.id} item={scenario} /><button className="text-button" type="button" onClick={onEdit}>编辑</button><button className="text-button danger-link" type="button" onClick={onDelete}>删除</button></div>
      <dl><div><dt>情境</dt><dd>{scenario.context}</dd></div><div><dt>操作</dt><dd>{scenario.action}</dd></div><div><dt>结果</dt><dd>{scenario.outcome}</dd></div></dl>
      <EvidenceLinks value={scenario.evidence} />
    </article>
  );
}
