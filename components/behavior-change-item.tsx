import type { BehaviorChangeRow } from "@/lib/types";
import { changeEvidence, changeSubject, isScenarioSubject } from "@/lib/spec-change-view";
import { kindLabels } from "./change-item";
import { EvidenceLinks } from "./evidence-links";

function ScenarioSubject({ title, value }: { title: string; value: { context: string; action: string; outcome: string } }) {
  return <div className="diff-column"><h4>{title}</h4><dl><div><dt>情境</dt><dd>{value.context}</dd></div><div><dt>操作</dt><dd>{value.action}</dd></div><div><dt>结果</dt><dd>{value.outcome}</dd></div></dl></div>;
}

function FeatureSubject({ title, value }: { title: string; value: unknown }) {
  const feature = value as { name?: string; summary?: string };
  return <div className="diff-column"><h4>{title}</h4><strong>{feature.name}</strong><p>{feature.summary}</p></div>;
}

function SubjectByType({ title, value }: { title: string; value: unknown }) {
  return isScenarioSubject(value)
    ? <ScenarioSubject title={title} value={value} />
    : <FeatureSubject title={title} value={value} />;
}

function ChangeSubject({ title, value }: { title: string; value: unknown }) {
  if (!value) return null;
  return <SubjectByType title={title} value={value} />;
}

export function BehaviorChangeItem({ change }: { change: BehaviorChangeRow }) {
  return (
    <article className="change-item behavior-change-item">
      <span className={`change-kind ${change.kind}`}>{kindLabels[change.kind]}</span>
      <div>
        <span className="change-feature">{change.featureName}{change.scenarioReference && ` · ${change.scenarioReference}`}{change.suspectedRenameWith && <span className="drift-badge">疑似改名 · {change.suspectedRenameWith}</span>}{change.highlightType && <span className="drift-badge" title={change.highlightReason ?? undefined}>Highlight · {change.highlightType}</span>}</span>
        <p>{change.summary}</p>
        <EvidenceLinks value={changeEvidence(change)} />
        <details className="behavior-details"><summary>查看前后差异</summary><div className="diff-grid"><ChangeSubject title="变更前" value={change.before} /><ChangeSubject title="变更后" value={change.after} /></div></details>
      </div>
    </article>
  );
}
