import { describe, expect, it } from "vitest";
import { canCreateChild, editorSubmitLabel, entityId, featureEditorKey, featureEditorProps, featureFormState, featureFormTitle, featureHref, featureMatches, featureNameLocked, featureSourceLabel, featureTabClass, scenarioBeingEdited, scenarioCategoryLabel, scenarioEditorKey, scenarioFilterCount, scenarioFilterLabel, scenarioFormState, scenarioFormTitle, scenariosForFeature, scenariosForFeatureTree, selectedClass } from "../lib/spec-editor-ui";

const feature = { id: 1, name: "Authentication", summary: "OAuth", parentId: null, source: "generated" as const, children: [] };
const scenario = { id: 1, featureId: 1, reference: "HP-1", context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" as const, source: "generated" as const, evidence: [] };

describe("spec editor presentation", () => {
  it("derives form state and titles without optional chaining in components", () => {
    expect(scenarioFormState(scenario)).toEqual({ context: "Visitor", action: "Signs in", outcome: "Dashboard", category: "happy" });
    expect(scenarioFormState(undefined)).toEqual({ context: "", action: "", outcome: "", category: "happy" });
    expect(scenarioFormTitle(scenario)).toBe("编辑场景 HP-1");
    expect(scenarioFormTitle(undefined)).toBe("新建场景");
    expect(featureFormState(feature)).toEqual({ name: "Authentication", summary: "OAuth" });
    expect(featureFormState(undefined)).toEqual({ name: "", summary: "" });
    expect(featureFormTitle(feature, 1)).toBe("编辑功能");
    expect(featureFormTitle(undefined, 1)).toBe("新建子功能");
    expect(featureFormTitle(undefined, null)).toBe("新建顶级功能");
    expect(editorSubmitLabel(true, "保存场景")).toBe("保存中…");
    expect(editorSubmitLabel(false, "保存场景")).toBe("保存场景");
  });

  it("filters feature trees and selects scenarios by feature", () => {
    expect(featureMatches(feature, "auth")).toBe(true);
    expect(featureMatches(feature, "missing")).toBe(false);
    expect(scenariosForFeature([scenario], feature)).toEqual([scenario]);
    expect(scenariosForFeature([scenario], { ...feature, id: 2 })).toEqual([]);
    expect(featureTabClass("flow", "flow")).toBe("selected");
    expect(featureTabClass("spec", "flow")).toBe("");
    expect(featureSourceLabel("manual")).toBe("人工维护");
    expect(featureSourceLabel("generated")).toBe("代码生成");
    expect(featureEditorProps("edit", feature)).toEqual({ feature, parentId: null });
    expect(featureEditorProps("edit", { ...feature, parentId: 8 })).toEqual({ feature: { ...feature, parentId: 8 }, parentId: 8 });
    expect(featureEditorProps("child", feature)).toEqual({ feature: undefined, parentId: 1 });
    expect(featureEditorProps("child", undefined)).toEqual({ feature: undefined, parentId: null });
    expect(featureEditorProps("root", feature)).toEqual({ feature: undefined, parentId: null });
    expect(featureEditorKey("edit", feature, null)).toBe("edit:1");
    expect(featureEditorKey("edit", { ...feature, id: 2 }, 1)).toBe("edit:2");
    expect(featureEditorKey("child", undefined, 1)).toBe("child:new:1");
    expect(featureEditorKey("child", feature, 1)).toBe("child:new:1");
    expect(scenarioEditorKey(scenario, 1)).toBe("scenario:1");
    expect(scenarioEditorKey({ ...scenario, id: 2 }, 1)).toBe("scenario:2");
    expect(scenarioEditorKey("new", 7)).toBe("new:7");
    expect(canCreateChild(feature)).toBe(true);
    expect(canCreateChild({ ...feature, parentId: 8 })).toBe(false);
    expect(featureNameLocked(feature)).toBe(true);
    expect(featureNameLocked({ ...feature, source: "manual" })).toBe(false);
    expect(featureNameLocked(undefined)).toBe(false);
    expect(entityId(feature)).toBe(1);
    expect(entityId(undefined)).toBeUndefined();
    expect(scenarioBeingEdited("new")).toBeUndefined();
    expect(scenarioBeingEdited(scenario)).toBe(scenario);
    expect(scenarioFilterLabel(undefined)).toBe("全部");
    expect(scenarioFilterLabel("edge")).toBe("边界情况");
    expect(scenarioFilterCount([scenario], undefined)).toBe(1);
    expect(scenarioFilterCount([scenario], "happy")).toBe(1);
    expect(scenarioFilterCount([scenario], "edge")).toBe(0);
  });

  it("builds spec editor URLs and shared tab classes", () => {
    expect(featureHref(7)).toBe("?view=spec&feature=7");
    expect(featureHref(7, "flow")).toBe("?view=spec&feature=7&mode=flow");
    expect(selectedClass(true)).toBe("selected");
    expect(selectedClass(false)).toBe("");
    expect(featureTabClass("flow", "flow")).toBe(selectedClass(true));
    expect(featureTabClass("spec", "flow")).toBe(selectedClass(false));
    expect(scenarioCategoryLabel("happy")).toBe("正常路径");
    expect(scenarioCategoryLabel("edge")).toBe("边界情况");
    expect(scenarioCategoryLabel("error")).toBe("错误路径");
    expect(scenarioCategoryLabel("other")).toBeUndefined();
    expect(scenarioFilterLabel("edge")).toBe(scenarioCategoryLabel("edge"));
  });

  it("collects scenarios of the selected feature and its children", () => {
    const tree = [{ ...feature, children: [{ ...feature, id: 2, name: "OAuth", parentId: 1 }, { ...feature, id: 3, name: "Password", parentId: 1 }] }];
    const own = scenario;
    const childScenario = { ...scenario, id: 2, featureId: 2, reference: "EC-1" };
    const otherScenario = { ...scenario, id: 3, featureId: 9, reference: "ER-1" };
    expect(scenariosForFeatureTree([own, childScenario, otherScenario], feature, tree)).toEqual([own, childScenario]);
    expect(scenariosForFeatureTree([own], feature, [])).toEqual([own]);
    expect(scenariosForFeatureTree([own], undefined, tree)).toEqual([]);
    expect(scenariosForFeatureTree([own], { ...feature, id: 42 }, tree)).toEqual([]);
  });
});
