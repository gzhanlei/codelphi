"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FeatureTreeItem } from "@/lib/feature-tree";
import type { FeatureRow, ScenarioRow } from "@/lib/types";
import { deleteConfirmedFeature } from "@/lib/spec-editor-client";
import { errorMessage } from "@/lib/error-message";
import { entityId, featureHref } from "@/lib/spec-editor-ui";
import { FeatureTree } from "./feature-tree";
import { useDemoGuard } from "./demo-mode";
import { FeatureEditor, SpecDetail, type FeatureEditorMode } from "./spec-workspace-content";

export function SpecWorkspace({ slug, tree, feature, scenarios, mode }: { slug: string; tree: FeatureTreeItem[]; feature?: FeatureRow; scenarios: ScenarioRow[]; mode: string }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [editor, setEditor] = useState<FeatureEditorMode>(null);
  const [error, setError] = useState("");

  async function removeFeature() {
    if (guard()) return;
    const deleted = await deleteConfirmedFeature(feature).catch((cause) => {
      setError(errorMessage(cause, "删除功能失败"));
      return false;
    });
    if (deleted) router.push("?view=spec");
  }

  return (
    <div className="spec-workspace">
      <FeatureTree slug={slug} items={tree} selectedId={entityId(feature)} onCreateRoot={() => setEditor("root")} />
      <div className="spec-detail">
        <FeatureEditor slug={slug} editor={editor} feature={feature} onSaved={(id) => { setEditor(null); router.push(featureHref(id)); }} onClose={() => setEditor(null)} />
        <SpecDetail feature={feature} scenarios={scenarios} mode={mode} error={error} onEdit={() => setEditor("edit")} onDelete={removeFeature} onCreateChild={() => setEditor("child")} onCreateRoot={() => setEditor("root")} />
      </div>
    </div>
  );
}
