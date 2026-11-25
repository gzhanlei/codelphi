import { describe, expect, it } from "vitest";
import {
  SpecIdentityError,
  emptyIdentityMaps,
  foldRegistry,
  planVersionIdentities,
  restoredFeatures,
  restoredScenarios,
  scenarioAssignments,
  scenarioIdentityKey,
  toVersionIdentities,
  type IdentityRegistry,
  type VersionIdentities,
  type VersionIdentityPlan,
} from "../lib/spec-identity";

const feature = (name: string, references: readonly string[] = [], parentKey: string | null = null) => ({ name, parentKey, references });

/** 按发布顺序走一遍版本：每一版用上一版的身份和累计的登记表。 */
function walk(versions: ReadonlyArray<ReturnType<typeof feature>[]>) {
  let previous: VersionIdentities = emptyIdentityMaps();
  let registry: IdentityRegistry = emptyIdentityMaps();
  return versions.map((features) => {
    const plan = planVersionIdentities({ features, previous, registry });
    registry = foldRegistry(registry, plan);
    previous = toVersionIdentities(plan);
    return plan;
  });
}

const identitiesOf = (plan: VersionIdentityPlan) => [...plan.features.values()].map((entry) => [entry.key, entry.identityKey, entry.origin] as const);

/** 跑一段会抛错的编排，返回错误码；没抛或者抛的不是身份层的错误，都原样报出来。 */
function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof SpecIdentityError ? error.code : `not a SpecIdentityError: ${String(error)}`;
  }
  return "did not throw";
}

describe("scenarioIdentityKey", () => {
  it("encodes the feature identity and the reference without ambiguity", () => {
    expect(scenarioIdentityKey("统一登录", "HP-1")).toBe('["统一登录","HP-1"]');
    // 直接拼接会撞车的两对，编码之后仍然分得开。
    expect(scenarioIdentityKey("a::HP-1", "EC-2")).not.toBe(scenarioIdentityKey("a", "HP-1::EC-2"));
  });
});

describe("首版：没有上一版，也没有登记表", () => {
  const [first] = walk([
    [feature("  统一  登录 ", ["HP-1", "EC-2"]), feature("会话管理", ["HP-1"], " 统一  登录 "), feature("支付")],
  ]);

  it("takes the name key of the first appearance as the feature identity", () => {
    expect(identitiesOf(first)).toEqual([
      ["统一 登录", "统一 登录", "minted"],
      ["会话管理", "会话管理", "minted"],
      ["支付", "支付", "minted"],
    ]);
  });

  it("derives each scenario identity from its feature identity and reference", () => {
    expect(scenarioAssignments(first)).toEqual([
      { featureIdentityKey: "统一 登录", reference: "HP-1", identityKey: '["统一 登录","HP-1"]', origin: "minted" },
      { featureIdentityKey: "统一 登录", reference: "EC-2", identityKey: '["统一 登录","EC-2"]', origin: "minted" },
      { featureIdentityKey: "会话管理", reference: "HP-1", identityKey: '["会话管理","HP-1"]', origin: "minted" },
    ]);
  });

  it("resolves the parent by its name key and leaves top-level features without one", () => {
    expect(first.features.get("会话管理")).toMatchObject({ parentIdentityKey: "统一 登录", parentResolved: true });
    expect(first.features.get("支付")).toMatchObject({ parentIdentityKey: null, parentResolved: true });
    expect(first.features.get("统一 登录")).toMatchObject({ parentIdentityKey: null, parentResolved: true });
  });

  it("lists everything as minted and nothing as retired or restored", () => {
    expect(first.minted.features).toEqual([
      { identityKey: "统一 登录", firstName: "统一  登录" },
      { identityKey: "会话管理", firstName: "会话管理" },
      { identityKey: "支付", firstName: "支付" },
    ]);
    expect(first.minted.scenarios.map((entry) => entry.identityKey)).toEqual(['["统一 登录","HP-1"]', '["统一 登录","EC-2"]', '["会话管理","HP-1"]']);
    expect(first.retired).toEqual({ features: [], scenarios: [] });
    expect(restoredFeatures(first)).toEqual([]);
    expect(restoredScenarios(first)).toEqual([]);
  });
});

describe("名称键没变就沿用", () => {
  const [, second] = walk([
    [feature("统一登录", ["HP-1", "EC-2"]), feature("会话管理", ["HP-1"], "统一登录")],
    [feature("统一登录", ["HP-1"]), feature("会话管理", ["HP-1", "ER-3"], "支付"), feature("支付", [], "统一登录")],
  ]);

  it("keeps the identity of a feature whose summary, parent or scenarios changed", () => {
    expect(second.features.get("统一登录")).toMatchObject({ identityKey: "统一登录", origin: "continued" });
    expect(second.features.get("会话管理")).toMatchObject({ identityKey: "会话管理", origin: "continued", parentIdentityKey: "支付", parentResolved: true });
  });

  it("mints the scenarios that appeared and retires the ones that disappeared", () => {
    expect(second.minted.features).toEqual([{ identityKey: "支付", firstName: "支付" }]);
    expect(second.minted.scenarios).toEqual([{ identityKey: '["会话管理","ER-3"]', featureIdentityKey: "会话管理", reference: "ER-3" }]);
    expect(second.retired.features).toEqual([]);
    expect(second.retired.scenarios).toEqual([{ identityKey: '["统一登录","EC-2"]', featureIdentityKey: "统一登录", reference: "EC-2" }]);
  });

  it("follows the reference, not the scenario text: HP-1 and HP-2 are different identities", () => {
    const [, renumbered] = walk([[feature("统一登录", ["HP-1"])], [feature("统一登录", ["HP-2"])]]);
    expect(renumbered.features.get("统一登录")).toMatchObject({ identityKey: "统一登录", origin: "continued" });
    expect(renumbered.features.get("统一登录")?.scenarios.get("HP-2")).toMatchObject({ identityKey: '["统一登录","HP-2"]', origin: "minted" });
    expect(renumbered.retired.scenarios).toEqual([{ identityKey: '["统一登录","HP-1"]', featureIdentityKey: "统一登录", reference: "HP-1" }]);
  });
});

describe("退休与恢复", () => {
  const [first, second, third] = walk([
    [feature("统一登录", ["HP-1"]), feature("支付", ["HP-1", "HP-2"])],
    [feature("统一登录", ["HP-1"])],
    [feature("统一登录", ["HP-1"]), feature("支付", ["HP-1"])],
  ]);

  it("retires a feature that dropped out of the version, together with its scenarios", () => {
    expect(second.retired.features).toEqual(["支付"]);
    expect(second.retired.scenarios).toEqual([
      { identityKey: '["支付","HP-1"]', featureIdentityKey: "支付", reference: "HP-1" },
      { identityKey: '["支付","HP-2"]', featureIdentityKey: "支付", reference: "HP-2" },
    ]);
  });

  it("restores a retired feature under its old identity instead of minting a new one", () => {
    expect(third.features.get("支付")).toMatchObject({ identityKey: "支付", origin: "restored" });
    expect(third.features.get("支付")?.scenarios.get("HP-1")).toMatchObject({ identityKey: '["支付","HP-1"]', origin: "restored" });
    expect(third.minted).toEqual({ features: [], scenarios: [] });
    expect(third.retired).toEqual({ features: [], scenarios: [] });
    expect(restoredFeatures(third)).toEqual(["支付"]);
    expect(restoredScenarios(third)).toEqual(['["支付","HP-1"]']);
  });

  it("mints a scenario that never existed under a restored feature", () => {
    const plan = planVersionIdentities({
      features: [feature("支付", ["HP-1", "HP-9"])],
      previous: toVersionIdentities(second),
      registry: foldRegistry(foldRegistry(emptyIdentityMaps(), first), second),
    });
    expect(plan.features.get("支付")?.scenarios.get("HP-9")).toMatchObject({ identityKey: '["支付","HP-9"]', origin: "minted" });
    expect(plan.features.get("支付")?.scenarios.get("HP-1")).toMatchObject({ origin: "restored" });
  });

  it("lists retired scenarios in code point order, whatever order they were stored in", () => {
    // 甲的码点比乙大，HP-10 排在 HP-1 和 HP-2 之间。存放顺序恰好都倒着。
    const [, plan] = walk([[feature("甲", ["EC-2", "EC-1"]), feature("乙", ["HP-2", "HP-10", "HP-1"])], [feature("甲", ["EC-2"])]]);
    expect(plan.retired.features).toEqual(["乙"]);
    expect(plan.retired.scenarios.map((entry) => `${entry.featureIdentityKey}/${entry.reference}`)).toEqual(["乙/HP-1", "乙/HP-10", "乙/HP-2", "甲/EC-1"]);
  });
});

describe("改名在登记表里有记录时", () => {
  it("treats a new name that points to a known identity as the same feature, not as removed plus added", () => {
    const [first] = walk([[feature("统一登录", ["HP-1"])]]);
    const renamed = emptyIdentityMaps();
    renamed.features.set("chandler 登录", "统一登录");
    const plan = planVersionIdentities({ features: [feature("Chandler 登录", ["HP-1"])], previous: toVersionIdentities(first), registry: renamed });

    expect(plan.features.get("chandler 登录")).toMatchObject({ identityKey: "统一登录", origin: "continued" });
    expect(plan.retired).toEqual({ features: [], scenarios: [] });
    expect(plan.minted).toEqual({ features: [], scenarios: [] });
  });

  it("refuses a version in which the old name and the new name are both present", () => {
    const renamed = emptyIdentityMaps();
    renamed.features.set("chandler 登录", "统一登录");
    expect(codeOf(() => planVersionIdentities({ features: [feature("统一登录"), feature("Chandler 登录")], previous: emptyIdentityMaps(), registry: renamed }))).toBe("identity_conflict");
  });
});

describe("父功能的身份", () => {
  it("is left unresolved when the parent name key is not in this version, instead of guessing", () => {
    const [plan] = walk([[feature("会话管理", ["HP-1"], "不存在的功能")]]);
    expect(plan.features.get("会话管理")).toMatchObject({ parentIdentityKey: null, parentResolved: false });
  });

  it("treats an empty parent key as top level", () => {
    const [plan] = walk([[feature("会话管理", ["HP-1"], "")]]);
    expect(plan.features.get("会话管理")).toMatchObject({ parentIdentityKey: null, parentResolved: true });
  });

  it("resolves a parent that is listed after its child", () => {
    const [plan] = walk([[feature("会话管理", ["HP-1"], "统一登录"), feature(" 统一登录 ", ["HP-1"])]]);
    expect(plan.features.get("会话管理")).toMatchObject({ parentIdentityKey: "统一登录", parentResolved: true });
  });
});

describe("失败关闭", () => {
  it("refuses two features with the same name key in one version", () => {
    expect(codeOf(() => planVersionIdentities({ features: [feature("统一登录"), feature(" 统一登录 ")], previous: emptyIdentityMaps(), registry: emptyIdentityMaps() }))).toBe("identity_input_invalid");
  });

  it("refuses a feature that repeats a reference", () => {
    expect(codeOf(() => planVersionIdentities({ features: [feature("统一登录", ["HP-1", "HP-1"])], previous: emptyIdentityMaps(), registry: emptyIdentityMaps() }))).toBe("identity_input_invalid");
  });

  it("refuses to choose when the previous version and the registry disagree about a name", () => {
    const previous = emptyIdentityMaps();
    previous.features.set("统一登录", "统一登录");
    const registry = emptyIdentityMaps();
    registry.features.set("统一登录", "另一个身份");
    expect(codeOf(() => planVersionIdentities({ features: [feature("统一登录")], previous, registry }))).toBe("identity_registry_conflict");
  });

  it("refuses to choose when they disagree about a scenario", () => {
    const previous = emptyIdentityMaps();
    previous.scenarios.set("统一登录", new Map([["HP-1", "S1"]]));
    const registry = emptyIdentityMaps();
    registry.scenarios.set("统一登录", new Map([["HP-1", "S2"]]));
    expect(codeOf(() => planVersionIdentities({ features: [feature("统一登录", ["HP-1"])], previous, registry }))).toBe("identity_registry_conflict");
  });

  it("refuses two references that resolve to the same scenario identity", () => {
    const registry = emptyIdentityMaps();
    registry.scenarios.set("统一登录", new Map([["HP-1", "S1"], ["HP-2", "S1"]]));
    expect(codeOf(() => planVersionIdentities({ features: [feature("统一登录", ["HP-1", "HP-2"])], previous: emptyIdentityMaps(), registry }))).toBe("identity_conflict");
  });
});

describe("登记表与下一版的身份", () => {
  it("folds only what was minted and never mutates the registry it was given", () => {
    const registry = emptyIdentityMaps();
    const plan = planVersionIdentities({ features: [feature("统一登录", ["HP-1"])], previous: emptyIdentityMaps(), registry });
    const folded = foldRegistry(registry, plan);
    expect(registry.features.size).toBe(0);
    expect(folded.features.get("统一登录")).toBe("统一登录");
    expect(folded.scenarios.get("统一登录")?.get("HP-1")).toBe('["统一登录","HP-1"]');
  });

  it("turns a plan into the identity map the next version starts from", () => {
    const [first, second] = walk([[feature("统一登录", ["HP-1"])], [feature("统一登录", ["HP-1", "HP-2"])]]);
    expect(toVersionIdentities(second)).toEqual({
      features: new Map([["统一登录", "统一登录"]]),
      scenarios: new Map([["统一登录", new Map([["HP-1", '["统一登录","HP-1"]'], ["HP-2", '["统一登录","HP-2"]']])]]),
    });
    expect(toVersionIdentities(first).scenarios.get("统一登录")).toEqual(new Map([["HP-1", '["统一登录","HP-1"]']]));
  });

  it("gives the same plan for the same input", () => {
    const input = { features: [feature("统一登录", ["HP-1"]), feature("支付", ["HP-1"], "统一登录")], previous: emptyIdentityMaps(), registry: emptyIdentityMaps() };
    expect(planVersionIdentities(input)).toEqual(planVersionIdentities(input));
  });
});
