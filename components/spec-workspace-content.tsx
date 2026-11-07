import type { FeatureRow, ScenarioRow } from "@/lib/types";
import { featureEditorKey, featureEditorProps } from "@/lib/spec-editor-ui";
import { FeatureForm } from "./feature-form";
import { FeatureDetail } from "./feature-detail";

export type FeatureEditorMode = "root" | "child" | "edit" | null;

export function FeatureEditor({ slug, editor, feature, onSaved, onClose }: { slug: string; editor: FeatureEditorMode; feature?: FeatureRow; onSaved: (id: number) => void; onClose: () => void }) {
  if (!editor) return null;
  const props = featureEditorProps(editor, feature);
  return <FeatureForm key={featureEditorKey(editor, feature, props.parentId)} slug={slug} feature={props.feature} parentId={props.parentId} onSaved={onSaved} onClose={onClose} />;
}

export function SpecDetail({ slug, feature, scenarios, implementationScenarios, mode, error, onEdit, onDelete, onCreateChild, onCreateRoot }: { slug: string; feature?: FeatureRow; scenarios: ScenarioRow[]; implementationScenarios?: ScenarioRow[]; mode: string; error: string; onEdit: () => void; onDelete: () => void; onCreateChild: () => void; onCreateRoot: () => void }) {
  if (!feature) return <div className="empty-state"><strong>选择一个功能</strong><p>从左侧功能树选择，或新建顶级功能。</p><button className="primary-button" type="button" onClick={onCreateRoot}>＋ 新功能</button></div>;
  return <FeatureDetail slug={slug} feature={feature} scenarios={scenarios} implementationScenarios={implementationScenarios} mode={mode} onEdit={onEdit} onDelete={onDelete} onCreateChild={onCreateChild} error={error} />;
}
