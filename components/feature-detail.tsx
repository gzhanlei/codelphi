import Link from "next/link";
import type { FeatureRow, ScenarioRow } from "@/lib/types";
import { aggregateImplementationFiles } from "@/lib/feature-implementation";
import { specFeatureKey } from "@/lib/spec-diff";
import { FeatureFlow } from "./feature-flow";
import { canCreateChild, featureHref, featureSourceLabel, featureTabClass } from "@/lib/spec-editor-ui";
import { VerifySpecButton } from "./verify-spec-button";
import { ScenarioWorkspace } from "./scenario-workspace";
import { FormError } from "./form-feedback";

function ImplementationFiles({ scenarios }: { scenarios?: ScenarioRow[] }) {
  const files = aggregateImplementationFiles(scenarios ?? []);
  if (files.length === 0) return null;
  return (
    <details className="implementation-files">
      <summary>实现分布 · {files.length} 个文件</summary>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            {file.url ? <a href={file.url} target="_blank" rel="noreferrer"><code>{file.path}</code> ↗</a> : <code>{file.path}</code>}
            {file.lines > 0 && <span className="implementation-lines">{file.lines} 行</span>}
            {file.references.map((reference) => <code className="implementation-reference" key={reference}>{reference}</code>)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function FeatureDetailHeader({ slug, feature, onEdit, onDelete }: { slug: string; feature: FeatureRow; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="feature-detail-header">
      <div><h2>{feature.name}{feature.staleSince ? <span className="drift-badge">可能过时</span> : null}</h2><p>{feature.summary}</p><span className="feature-source">{featureSourceLabel(feature.source)}</span>
        <Link className="stable-link" href={`/products/${slug}/spec/feature/${encodeURIComponent(specFeatureKey(feature.name))}`} title="始终解析到最新规格的稳定链接">稳定链接 <code>{specFeatureKey(feature.name)}</code></Link>
      </div>
      <div className="feature-actions"><VerifySpecButton slug={slug} entityType="feature" entityId={feature.id} item={feature} /><button className="text-button" type="button" onClick={onEdit}>编辑</button><button className="text-button danger-link" type="button" onClick={onDelete}>删除</button></div>
    </div>
  );
}

function ChildFeatureAction({ feature, onCreateChild }: { feature: FeatureRow; onCreateChild: () => void }) {
  if (!canCreateChild(feature)) return null;
  return <div className="feature-actions secondary-actions"><button className="text-button" type="button" onClick={onCreateChild}>＋ 子功能</button></div>;
}

export function FeatureDetail({ slug, feature, scenarios, implementationScenarios, mode, onEdit, onDelete, onCreateChild, error }: { slug: string; feature: FeatureRow; scenarios: ScenarioRow[]; implementationScenarios?: ScenarioRow[]; mode: string; onEdit: () => void; onDelete: () => void; onCreateChild: () => void; error: string }) {
  return (
    <>
      <FeatureDetailHeader slug={slug} feature={feature} onEdit={onEdit} onDelete={onDelete} />
      <ChildFeatureAction feature={feature} onCreateChild={onCreateChild} />
      <ImplementationFiles scenarios={implementationScenarios} />
      <nav className="feature-view-tabs" aria-label="功能视图"><Link className={featureTabClass(mode, "spec")} href={featureHref(feature.id)}>场景 <span>{scenarios.length}</span></Link><Link className={featureTabClass(mode, "flow")} href={featureHref(feature.id, "flow")}>流程图</Link></nav>
      <FormError message={error} />
      {mode === "flow" ? <FeatureFlow featureName={feature.name} scenarios={scenarios} /> : <ScenarioWorkspace key={feature.id} slug={slug} featureId={feature.id} scenarios={scenarios} />}
    </>
  );
}
