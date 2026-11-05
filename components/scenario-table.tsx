import type { ScenarioRow } from "@/lib/types";
import { scenarioCategoryLabel } from "@/lib/spec-editor-ui";

export function ScenarioTable({ scenarios, onEdit, onDelete }: { scenarios: ScenarioRow[]; onEdit: (scenario: ScenarioRow) => void; onDelete: (scenario: ScenarioRow) => void }) {
  return (
    <div className="scenario-table-wrapper"><table className="scenario-table"><thead><tr><th>场景</th><th>情境</th><th>操作</th><th>结果</th><th>操作</th></tr></thead><tbody>{scenarios.map((scenario) => <tr key={scenario.id}><td><span className={`scenario-kind ${scenario.category}`}>{scenarioCategoryLabel(scenario.category)}</span><code>{scenario.reference}</code></td><td>{scenario.context}</td><td>{scenario.action}</td><td>{scenario.outcome}</td><td><button className="text-button" onClick={() => onEdit(scenario)} type="button">编辑</button><button className="text-button danger-link" onClick={() => onDelete(scenario)} type="button">删除</button></td></tr>)}</tbody></table></div>
  );
}
