import type { ScenarioRow } from "@/lib/types";
import { scenarioBeingEdited, scenarioEditorKey } from "@/lib/spec-editor-ui";
import { ScenarioForm } from "./scenario-form";
import { ScenarioTable } from "./scenario-table";
import { ScenarioCard } from "./scenario-card";

function ScenarioList({ scenarios, view, onEdit, onDelete }: { scenarios: ScenarioRow[]; view: "list" | "table"; onEdit: (scenario: ScenarioRow) => void; onDelete: (scenario: ScenarioRow) => void }) {
  return view === "table"
    ? <ScenarioTable scenarios={scenarios} onEdit={onEdit} onDelete={onDelete} />
    : <div className="scenario-list">{scenarios.map((scenario) => <ScenarioCard scenario={scenario} onEdit={() => onEdit(scenario)} onDelete={() => onDelete(scenario)} key={scenario.id} />)}</div>;
}

function ScenarioResults({ scenarios, view, onEdit, onDelete }: { scenarios: ScenarioRow[]; view: "list" | "table"; onEdit: (scenario: ScenarioRow) => void; onDelete: (scenario: ScenarioRow) => void }) {
  if (!scenarios.length) return <div className="empty-state">没有匹配场景，调整筛选或新建一个场景。</div>;
  return <ScenarioList scenarios={scenarios} view={view} onEdit={onEdit} onDelete={onDelete} />;
}

export function ScenarioContent({ editing, scenarios, view, featureId, onClose, onSaved, onEdit, onDelete }: { editing?: ScenarioRow | "new" | null; scenarios: ScenarioRow[]; view: "list" | "table"; featureId: number; onClose: () => void; onSaved: () => void; onEdit: (scenario: ScenarioRow) => void; onDelete: (scenario: ScenarioRow) => void }) {
  return (
    <>
      {editing && <ScenarioForm key={scenarioEditorKey(editing, featureId)} featureId={featureId} scenario={scenarioBeingEdited(editing)} onClose={onClose} onSaved={onSaved} />}
      <ScenarioResults scenarios={scenarios} view={view} onEdit={onEdit} onDelete={onDelete} />
    </>
  );
}
