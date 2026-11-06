import { describe, expect, it } from "vitest";
import { toGherkin, toMarkdownChecklist } from "../lib/scenario-export";
import type { FeatureRow, ScenarioRow } from "../lib/types";

const login: FeatureRow = { id: 1, name: "登录", summary: "OAuth 登录", parentId: null, source: "generated" };
const oauth: FeatureRow = { id: 2, name: "OAuth 回调", summary: "回调处理", parentId: 1, source: "manual" };
const features = [login, oauth];

function scenario(id: number, featureId: number, reference: string, category: ScenarioRow["category"], context: string, action: string, outcome: string): ScenarioRow {
  return { id, featureId, reference, context, action, outcome, category, source: "generated", evidence: [] };
}

const scenarios = [
  scenario(1, 1, "HP-1", "happy", "访客打开登录页", "点击 GitHub 登录", "跳转授权页"),
  scenario(2, 2, "EC-2", "edge", "回调带错误码", "进入回调页", "展示错误提示"),
  scenario(3, 1, "ER-1", "error", "会话过期", "刷新页面", "回到登录页"),
];

describe("toGherkin", () => {
  it("renders nested features with tagged scenarios", () => {
    const gherkin = toGherkin(features, scenarios);
    expect(gherkin).toContain("Feature: 登录");
    expect(gherkin).toContain("Rule: OAuth 回调");
    expect(gherkin).toContain("@happy @HP-1");
    expect(gherkin).toContain("Scenario: HP-1");
    expect(gherkin).toContain("Given 访客打开登录页");
    expect(gherkin).toContain("When 点击 GitHub 登录");
    expect(gherkin).toContain("Then 跳转授权页");
    expect(gherkin).toContain("@error @ER-1");
  });

  it("keeps rule scenarios indented deeper than feature scenarios", () => {
    const gherkin = toGherkin(features, scenarios);
    const featureScenario = gherkin.indexOf("Scenario: HP-1");
    const ruleScenario = gherkin.indexOf("Scenario: EC-2");
    const indentOf = (index: number) => gherkin.slice(0, index).length - gherkin.slice(0, index).trimEnd().length + gherkin.slice(index).length - gherkin.slice(index).trimStart().length;
    expect(indentOf(ruleScenario)).toBeGreaterThan(indentOf(featureScenario));
  });

  it("flattens multi-line step text onto one line", () => {
    const gherkin = toGherkin([login], [scenario(9, 1, "HP-9", "happy", "第一行\n第二行", "操作", "结果")]);
    expect(gherkin).toContain("Given 第一行 第二行");
  });

  it("returns empty output without features", () => {
    expect(toGherkin([], scenarios)).toBe("");
  });
});

describe("toMarkdownChecklist", () => {
  it("renders grouped checklists with category labels", () => {
    const markdown = toMarkdownChecklist(features, scenarios);
    expect(markdown).toContain("## 登录");
    expect(markdown).toContain("### OAuth 回调");
    expect(markdown).toContain("- [ ] HP-1（正常路径）情境：访客打开登录页｜操作：点击 GitHub 登录｜结果：跳转授权页");
    expect(markdown).toContain("- [ ] EC-2（边界情况）");
    expect(markdown).toContain("- [ ] ER-1（错误路径）");
  });

  it("returns empty output without features", () => {
    expect(toMarkdownChecklist([], [])).toBe("");
  });
});
