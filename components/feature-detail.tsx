import Link from "next/link";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { FEATURE_DETAIL } from "@/lib/ui-strings/product";
import { formatDateIn } from "@/lib/format";
import type { FeatureRow, ScenarioRow } from "@/lib/types";
import type { FeatureFlowGraph } from "@/lib/semantic-feature-flow";
import { aggregateImplementationFiles } from "@/lib/feature-implementation";
import { specFeatureKey } from "@/lib/spec-diff";
import { FeatureFlow } from "./feature-flow";
import { canCreateChild, featureHref, featureSourceLabel, featureTabClass } from "@/lib/spec-editor-ui";
import { VerifySpecButton } from "./verify-spec-button";
import { ScenarioWorkspace } from "./scenario-workspace";
import { FormError } from "./form-feedback";
import { FeatureHistory } from "./feature-history";
import { FeatureConnectionsPanel } from "./feature-connections-panel";

function ImplementationFiles({ scenarios, locale = "zh-CN" }: { scenarios?: ScenarioRow[]; locale?: UiLocale }) {
  const files = aggregateImplementationFiles(scenarios ?? []);
  if (files.length === 0) return null;
  return (
    <details className="implementation-files">
      <summary>{pick(locale, FEATURE_DETAIL.implementationFiles).replace("{count}", String(files.length))}</summary>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            {file.url ? <a href={file.url} target="_blank" rel="noreferrer"><code>{file.path}</code> ↗</a> : <code>{file.path}</code>}
            {file.lines > 0 && <span className="implementation-lines">{pick(locale, FEATURE_DETAIL.implementationLines).replace("{count}", String(file.lines))}</span>}
            {file.references.map((reference) => <code className="implementation-reference" key={reference}>{reference}</code>)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function FeatureDetailHeader({ slug, productBase, feature, onEdit, onDelete, locale = "zh-CN" }: { slug: string; productBase: string; feature: FeatureRow; onEdit: () => void; onDelete: () => void; locale?: UiLocale }) {
  // 与原 toLocaleString("zh-CN") 同构的数字式日期时间（缺省 locale 渲染不变，仅随 locale 切换）
  const editedAt = feature.lastEditedAt ? formatDateIn(locale, feature.lastEditedAt, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "";
  return (
    <div className="feature-detail-header">
      <div><h2>{feature.name}{feature.staleSince ? <span className="drift-badge">{pick(locale, FEATURE_DETAIL.staleBadge)}</span> : null}</h2><p>{feature.summary}</p><span className="feature-source">{featureSourceLabel(feature.source, locale)}</span>{feature.lastEditedBy ? <span className="edited-by" title={feature.lastEditedAt ? pick(locale, FEATURE_DETAIL.lastEditedAtTitle).replace("{time}", editedAt) : undefined}>{pick(locale, FEATURE_DETAIL.editedBy).replace("{name}", feature.lastEditedBy)}</span> : null}
        <Link className="stable-link" href={`${productBase}/spec/feature/${encodeURIComponent(specFeatureKey(feature.name))}`} title={pick(locale, FEATURE_DETAIL.stableLinkTitle)}>{pick(locale, FEATURE_DETAIL.stableLink)} <code>{specFeatureKey(feature.name)}</code></Link>
      </div>
      <div className="feature-actions"><VerifySpecButton slug={slug} entityType="feature" entityId={feature.id} item={feature} /><button className="text-button" type="button" onClick={onEdit}>{pick(locale, FEATURE_DETAIL.edit)}</button><button className="text-button danger-link" type="button" onClick={onDelete}>{pick(locale, FEATURE_DETAIL.remove)}</button></div>
    </div>
  );
}

function ChildFeatureAction({ feature, onCreateChild, locale = "zh-CN" }: { feature: FeatureRow; onCreateChild: () => void; locale?: UiLocale }) {
  if (!canCreateChild(feature)) return null;
  return <div className="feature-actions secondary-actions"><button className="text-button" type="button" onClick={onCreateChild}>{pick(locale, FEATURE_DETAIL.addChild)}</button></div>;
}

export function FeatureDetail({ slug, productBase, feature, scenarios, implementationScenarios, mode, flowGraph, flowErrorCode, onEdit, onDelete, onCreateChild, error, locale = "zh-CN" }: { slug: string; productBase: string; feature: FeatureRow; scenarios: ScenarioRow[]; implementationScenarios?: ScenarioRow[]; mode: string; flowGraph?: FeatureFlowGraph; flowErrorCode?: string; onEdit: () => void; onDelete: () => void; onCreateChild: () => void; error: string; locale?: UiLocale }) {
  return (
    <>
      <FeatureDetailHeader slug={slug} productBase={productBase} feature={feature} onEdit={onEdit} onDelete={onDelete} locale={locale} />
      <ChildFeatureAction feature={feature} onCreateChild={onCreateChild} locale={locale} />
      <ImplementationFiles scenarios={implementationScenarios} locale={locale} />
      <FeatureHistory slug={slug} featureId={feature.id} featureName={feature.name} locale={locale} />
      <FeatureConnectionsPanel slug={slug} featureId={feature.id} />
      <nav className="feature-view-tabs" aria-label={pick(locale, FEATURE_DETAIL.viewsAria)}><Link scroll={false} className={featureTabClass(mode, "spec")} href={featureHref(feature.id)}>{pick(locale, FEATURE_DETAIL.tabScenarios)} <span>{scenarios.length}</span></Link><Link scroll={false} className={featureTabClass(mode, "flow")} href={featureHref(feature.id, "flow")}>{pick(locale, FEATURE_DETAIL.tabFlow)}</Link></nav>
      <FormError message={error} />
      {mode === "flow" ? <FeatureFlow featureName={feature.name} scenarios={scenarios} graph={flowGraph} errorCode={flowErrorCode} /> : <ScenarioWorkspace key={feature.id} slug={slug} featureId={feature.id} scenarios={scenarios} />}
    </>
  );
}
