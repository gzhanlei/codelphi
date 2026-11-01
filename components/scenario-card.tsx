import type { ScenarioRow } from "@/lib/types";
import { EvidenceLinks } from "./evidence-links";

export const categoryLabels: Record<string, string> = { happy: "正常路径", edge: "边界情况", error: "错误路径" };

export function ScenarioCard({ scenario, onEdit, onDelete }: { scenario: ScenarioRow; onEdit: () => void; onDelete: () => void }) {
  return (
    <article className="scenario">
      <div className="scenario-label"><span className={`scenario-kind ${scenario.category}`}>{categoryLabels[scenario.category]}</span><code>{scenario.reference}</code><span className="scenario-source">{scenario.source === "manual" ? "人工" : "生成"}</span><button className="text-button" type="button" onClick={onEdit}>编辑</button><button className="text-button danger-link" type="button" onClick={onDelete}>删除</button></div>
      <dl><div><dt>情境</dt><dd>{scenario.context}</dd></div><div><dt>操作</dt><dd>{scenario.action}</dd></div><div><dt>结果</dt><dd>{scenario.outcome}</dd></div></dl>
      <EvidenceLinks value={scenario.evidence} />
    </article>
  );
}
