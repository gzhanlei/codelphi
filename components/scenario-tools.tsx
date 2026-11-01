"use client";

import type { ScenarioRow } from "@/lib/types";

type ScenarioCategory = ScenarioRow["category"];
import { featureTabClass, scenarioFilterCount, scenarioFilterLabel } from "@/lib/spec-editor-ui";

interface Props {
  category: string;
  query: string;
  view: "list" | "table";
  scenarios: ScenarioRow[];
  onCategory: (value: string) => void;
  onQuery: (value: string) => void;
  onView: (value: "list" | "table") => void;
  onNew: () => void;
}

function ScenarioFilters({ category, scenarios, onCategory }: Pick<Props, "category" | "scenarios" | "onCategory">) {
  const categories: Array<[string, ScenarioCategory | undefined]> = [["all", undefined], ["happy", "happy"], ["edge", "edge"], ["error", "error"]];
  return <div className="scenario-filter-group">{categories.map(([value, item]) => <button className={featureTabClass(category, value)} onClick={() => onCategory(value)} type="button" key={value}>{scenarioFilterLabel(item)} {scenarioFilterCount(scenarios, item)}</button>)}</div>;
}

function ScenarioViewButtons({ view, onView }: Pick<Props, "view" | "onView">) {
  return <><button className={featureTabClass(view, "list")} type="button" onClick={() => onView("list")}>列表</button><button className={featureTabClass(view, "table")} type="button" onClick={() => onView("table")}>表格</button></>;
}

export function ScenarioTools({ category, query, view, scenarios, onCategory, onQuery, onView, onNew }: Props) {
  return (
    <div className="scenario-tools">
      <ScenarioFilters category={category} scenarios={scenarios} onCategory={onCategory} />
      <div className="scenario-view-tools"><input aria-label="搜索场景" placeholder="搜索场景" value={query} onChange={(event) => onQuery(event.target.value)} /><ScenarioViewButtons view={view} onView={onView} /><button className="primary-button" type="button" onClick={onNew}>＋ 新场景</button></div>
    </div>
  );
}
