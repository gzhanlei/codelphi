"use client";

import type { ScenarioRow } from "@/lib/types";

type ScenarioCategory = ScenarioRow["category"];
import { featureTabClass, scenarioFilterCount, scenarioFilterLabel } from "@/lib/spec-editor-ui";

interface Props {
  category: string;
  query: string;
  verification: string;
  view: "list" | "table";
  scenarios: ScenarioRow[];
  onCategory: (value: string) => void;
  onQuery: (value: string) => void;
  onVerification: (value: string) => void;
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

export function ScenarioTools({ category, query, verification, view, scenarios, onCategory, onQuery, onVerification, onView, onNew }: Props) {
  return (
    <div className="scenario-tools">
      <ScenarioFilters category={category} scenarios={scenarios} onCategory={onCategory} />
      <div className="scenario-view-tools"><select aria-label="按核实状态筛选" className="regression-status" value={verification} onChange={(event) => onVerification(event.target.value)}><option value="all">全部核实状态</option><option value="unverified">未核实</option><option value="verified">已核实</option><option value="stale-verified">待重新核实</option></select><input aria-label="搜索场景" placeholder="搜索场景" value={query} onChange={(event) => onQuery(event.target.value)} /><ScenarioViewButtons view={view} onView={onView} /><button className="primary-button" type="button" onClick={onNew}>＋ 新场景</button></div>
    </div>
  );
}
