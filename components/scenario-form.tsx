"use client";

import { useState } from "react";
import type { ScenarioRow } from "@/lib/types";
import { errorMessage } from "@/lib/error-message";
import { saveScenario } from "@/lib/spec-editor-client";
import { FormError } from "./form-feedback";
import { entityId, scenarioFormState, scenarioFormTitle } from "@/lib/spec-editor-ui";
import { ScenarioFields } from "./scenario-fields";
import { EditorActions } from "./editor-actions";

export function ScenarioForm({ featureId, scenario, onSaved, onClose }: { featureId: number; scenario?: ScenarioRow; onSaved: () => void; onClose: () => void }) {
  const initial = scenarioFormState(scenario);
  const [context, setContext] = useState(initial.context);
  const [action, setAction] = useState(initial.action);
  const [outcome, setOutcome] = useState(initial.outcome);
  const [category, setCategory] = useState(initial.category);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await saveScenario(featureId, { context, action, outcome, category: category as "happy" | "edge" | "error" }, entityId(scenario));
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "保存场景失败"));
      setPending(false);
    }
  }

  return (
    <form className="editor-panel" onSubmit={submit}>
      <h3>{scenarioFormTitle(scenario)}</h3>
      <ScenarioFields context={context} action={action} outcome={outcome} category={category} onContextChange={setContext} onActionChange={setAction} onOutcomeChange={setOutcome} onCategoryChange={setCategory} />
      <FormError message={error} />
      <EditorActions pending={pending} label="保存场景" onCancel={onClose} />
    </form>
  );
}
