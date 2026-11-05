"use client";

import { useState } from "react";
import type { FeatureRow } from "@/lib/types";
import { errorMessage } from "@/lib/error-message";
import { saveFeature } from "@/lib/spec-editor-client";
import { FormError } from "./form-feedback";
import { useDemoMode } from "./demo-mode";
import { entityId, featureFormState, featureFormTitle, featureNameLocked } from "@/lib/spec-editor-ui";
import { FeatureFields } from "./feature-fields";
import { EditorActions } from "./editor-actions";

export function FeatureForm({ slug, feature, parentId, onSaved, onClose }: { slug: string; feature?: FeatureRow; parentId: number | null; onSaved: (id: number) => void; onClose: () => void }) {
  const { demo, showNotice } = useDemoMode();
  const initial = featureFormState(feature);
  const [name, setName] = useState(initial.name);
  const [summary, setSummary] = useState(initial.summary);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (demo) {
      showNotice();
      return;
    }
    setPending(true);
    setError("");
    try {
      const result = await saveFeature(slug, { name, summary, parentId }, entityId(feature));
      onSaved(result.id as number);
    } catch (cause) {
      setError(errorMessage(cause, "保存功能失败"));
      setPending(false);
    }
  }

  return (
    <form className="editor-panel" onSubmit={submit}>
      <h3>{featureFormTitle(feature, parentId)}</h3>
      <FeatureFields name={name} summary={summary} locked={featureNameLocked(feature)} onNameChange={setName} onSummaryChange={setSummary} />
      <FormError message={error} />
      <EditorActions pending={pending} label="保存功能" onCancel={onClose} />
    </form>
  );
}
