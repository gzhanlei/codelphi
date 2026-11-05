"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ScenarioRow } from "@/lib/types";
import { scenarioMatches } from "@/lib/feature-tree";
import { deleteConfirmedScenario } from "@/lib/spec-editor-client";
import { errorMessage } from "@/lib/error-message";
import { FormError } from "./form-feedback";
import { useDemoGuard } from "./demo-mode";
import { ScenarioTools } from "./scenario-tools";
import { ScenarioContent } from "./scenario-content";

export function ScenarioWorkspace({ featureId, scenarios }: { featureId: number; scenarios: ScenarioRow[] }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"list" | "table">("list");
  const [editing, setEditing] = useState<ScenarioRow | "new" | null>(null);
  const [error, setError] = useState("");
  const filtered = scenarios.filter((scenario) => scenarioMatches(scenario, query, category));

  async function remove(scenario: ScenarioRow) {
    if (guard()) return;
    const deleted = await deleteConfirmedScenario(scenario).catch((cause) => {
      setError(errorMessage(cause, "删除场景失败"));
      return false;
    });
    if (deleted) router.refresh();
  }

  return (
    <section className="scenario-workspace">
      <ScenarioTools category={category} query={query} view={view} scenarios={scenarios} onCategory={setCategory} onQuery={setQuery} onView={setView} onNew={() => setEditing("new")} />
      <FormError message={error} />
      <ScenarioContent editing={editing} scenarios={filtered} view={view} featureId={featureId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} onEdit={setEditing} onDelete={remove} />
    </section>
  );
}
