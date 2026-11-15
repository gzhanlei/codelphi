import type { FeatureRow, ScenarioRow } from "@/lib/types";
import type { FeatureFlowGraph } from "@/lib/semantic-feature-flow";
import { featureEditorKey, featureEditorProps } from "@/lib/spec-editor-ui";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { SPEC_EDITOR } from "@/lib/ui-strings/product";
import { FeatureForm } from "./feature-form";
import { FeatureDetail } from "./feature-detail";

export type FeatureEditorMode = "root" | "child" | "edit" | null;

export function FeatureEditor({ slug, editor, feature, onSaved, onClose }: { slug: string; editor: FeatureEditorMode; feature?: FeatureRow; onSaved: (id: number) => void; onClose: () => void }) {
  if (!editor) return null;
  const props = featureEditorProps(editor, feature);
  return <FeatureForm key={featureEditorKey(editor, feature, props.parentId)} slug={slug} feature={props.feature} parentId={props.parentId} onSaved={onSaved} onClose={onClose} />;
}

export function SpecDetail({ slug, productBase, feature, scenarios, implementationScenarios, mode, error, featureFlow, featureFlowErrorCode, onEdit, onDelete, onCreateChild, onCreateRoot, locale = "zh-CN" }: { slug: string; productBase: string; feature?: FeatureRow; scenarios: ScenarioRow[]; implementationScenarios?: ScenarioRow[]; mode: string; error: string; featureFlow?: FeatureFlowGraph; featureFlowErrorCode?: string; onEdit: () => void; onDelete: () => void; onCreateChild: () => void; onCreateRoot: () => void; locale?: UiLocale }) {
  if (!feature) {
    return (
      <div className="empty-state">
        <strong>{pick(locale, SPEC_EDITOR.emptyTitle)}</strong>
        <p>{pick(locale, SPEC_EDITOR.emptyBody)}</p>
        <button className="primary-button" type="button" onClick={onCreateRoot}>{pick(locale, SPEC_EDITOR.newFeature)}</button>
      </div>
    );
  }
  return <FeatureDetail slug={slug} productBase={productBase} feature={feature} scenarios={scenarios} implementationScenarios={implementationScenarios} mode={mode} flowGraph={featureFlow} flowErrorCode={featureFlowErrorCode} onEdit={onEdit} onDelete={onDelete} onCreateChild={onCreateChild} error={error} locale={locale} />;
}
