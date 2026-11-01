import type { FeatureRow, ScenarioRow } from "@/lib/types";
import { EvidenceLinks } from "./evidence-links";

const categoryLabels: Record<string, string> = { happy: "正常路径", edge: "边界情况", error: "错误路径" };

export function ProductSpec({ features, scenarios }: { features: FeatureRow[]; scenarios: ScenarioRow[] }) {
  if (features.length === 0) {
    return <div className="empty-state"><strong>还没有产品规格</strong><p>点击“立即分析”，Radar 会从当前代码生成功能与场景。</p></div>;
  }

  return (
    <div className="feature-list">
      {features.map((feature) => {
        const items = scenarios.filter((scenario) => scenario.featureId === feature.id);
        return (
          <section className="feature-card" key={feature.id}>
            <div className="feature-header"><div><h2>{feature.name}</h2><p>{feature.summary}</p></div><span>{items.length} 个场景</span></div>
            <div className="scenario-list">
              {items.map((scenario) => (
                <article className="scenario" key={scenario.id}>
                  <div className="scenario-label"><span className={`scenario-kind ${scenario.category}`}>{categoryLabels[scenario.category]}</span><code>{scenario.reference}</code></div>
                  <dl>
                    <div><dt>情境</dt><dd>{scenario.context}</dd></div>
                    <div><dt>操作</dt><dd>{scenario.action}</dd></div>
                    <div><dt>结果</dt><dd>{scenario.outcome}</dd></div>
                  </dl>
                  <EvidenceLinks value={scenario.evidence} />
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
