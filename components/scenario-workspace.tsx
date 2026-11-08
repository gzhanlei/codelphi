"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ScenarioRow } from "@/lib/types";
import { scenarioMatches } from "@/lib/feature-tree";
import { verificationMatches } from "@/lib/spec-editor-ui";
import { deleteConfirmedScenario } from "@/lib/spec-editor-client";
import { errorMessage } from "@/lib/error-message";
import { FormError } from "./form-feedback";
import { useDemoGuard } from "./demo-mode";
import { ScenarioTools } from "./scenario-tools";
import { ScenarioContent } from "./scenario-content";

export function ScenarioWorkspace({ slug, featureId, scenarios }: { slug: string; featureId: number; scenarios: ScenarioRow[] }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [verification, setVerification] = useState("all");
  const [view, setView] = useState<"list" | "table">("list");
  const [editing, setEditing] = useState<ScenarioRow | "new" | null>(null);
  const [error, setError] = useState("");
  const filtered = scenarios.filter((scenario) => verificationMatches(scenario, verification) && scenarioMatches(scenario, query, category));

  async function remove(scenario: ScenarioRow) {
    if (guard()) return;
    const deleted = await deleteConfirmedScenario(scenario).catch((cause) => {
      setError(errorMessage(cause, "删除场景失败"));
      return false;
    });
    if (deleted) router.refresh();
  }

  // 只读 demo 下编辑面板不该打开：编辑入口先过 demo guard，保存时再拦一次。
  const openEditing = (target: ScenarioRow | "new") => {
    if (guard()) return;
    setEditing(target);
  };

  return (
    <section className="scenario-workspace">
      <ScenarioTools category={category} query={query} verification={verification} view={view} scenarios={scenarios} onCategory={setCategory} onQuery={setQuery} onVerification={setVerification} onView={setView} onNew={() => openEditing("new")} />
      <FormError message={error} />
      <ScenarioContent slug={slug} editing={editing} scenarios={filtered} view={view} featureId={featureId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); router.refresh(); }} onEdit={openEditing} onDelete={remove} />
    </section>
  );
}
