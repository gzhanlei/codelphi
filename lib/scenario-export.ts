import { buildFeatureTree, type FeatureTreeItem } from "./feature-tree";
import type { FeatureRow, ScenarioRow } from "./types";

const categoryLabels: Record<ScenarioRow["category"], string> = { happy: "正常路径", edge: "边界情况", error: "错误路径" };

function flatten(text: string) {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function scenariosOf(featureId: number, scenarios: ScenarioRow[]) {
  return scenarios.filter((scenario) => scenario.featureId === featureId);
}

function scenarioBlock(scenario: ScenarioRow, indent: string) {
  return [
    `${indent}@${scenario.category} @${scenario.reference}`,
    `${indent}Scenario: ${scenario.reference}`,
    `${indent}  Given ${flatten(scenario.context)}`,
    `${indent}  When ${flatten(scenario.action)}`,
    `${indent}  Then ${flatten(scenario.outcome)}`,
  ].join("\n");
}

function gherkinFor(item: FeatureTreeItem, scenarios: ScenarioRow[], indent: string): string {
  const blocks = [`Feature: ${item.name}\n${indent}# ${flatten(item.summary)}`];
  for (const scenario of scenariosOf(item.id, scenarios)) blocks.push(scenarioBlock(scenario, indent));
  for (const child of item.children) {
    blocks.push(`${indent}Rule: ${child.name}\n${indent}  # ${flatten(child.summary)}`);
    for (const scenario of scenariosOf(child.id, scenarios)) {
      blocks.push(scenarioBlock(scenario, `${indent}  `));
    }
  }
  return blocks.join("\n\n");
}

/** 场景 → Gherkin 骨架（HP/EC/ER 编号与分类作 tag，可直接放进 Cucumber/Playwright 项目）。 */
export function toGherkin(features: FeatureRow[], scenarios: ScenarioRow[]): string {
  const tree = buildFeatureTree(features);
  return tree.map((item) => gherkinFor(item, scenarios, "")).join("\n\n").trim();
}

function markdownFor(feature: FeatureRow, scenarios: ScenarioRow[], level: number): string {
  const lines = [`${"#".repeat(level)} ${feature.name}（${flatten(feature.summary)}）`];
  for (const scenario of scenariosOf(feature.id, scenarios)) {
    lines.push(`- [ ] ${scenario.reference}（${categoryLabels[scenario.category]}）情境：${flatten(scenario.context)}｜操作：${flatten(scenario.action)}｜结果：${flatten(scenario.outcome)}`);
  }
  return lines.join("\n");
}

/** 场景 → Markdown 用例清单（复选框形式，可贴进测试计划或工单）。 */
export function toMarkdownChecklist(features: FeatureRow[], scenarios: ScenarioRow[]): string {
  const tree = buildFeatureTree(features);
  return tree.map((item) => [markdownFor(item, scenarios, 2), ...item.children.map((child) => markdownFor(child, scenarios, 3))].join("\n")).join("\n\n").trim();
}
