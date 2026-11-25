import { describe, expect, it } from "vitest";
import { compareDiffPairing, diffSpecWithFolded, type DiffIdentities, type SpecChange, type SpecFeature } from "../lib/spec-diff";

const scenario = (reference: string, outcome = "Works") => ({ reference, context: "User", action: "Does it", outcome, category: "happy" as const, evidence: [] });
const feature = (name: string, scenarios: SpecFeature["scenarios"] = [], parentKey: string | null = null, summary = `${name} summary`): SpecFeature => ({ name, summary, parentKey, scenarios });
/** 名称键 → 身份键。没列在里面的功能就是“这一侧没有身份”。 */
const identities = (keys: Record<string, string>): DiffIdentities["before"] => new Map(Object.entries(keys));
const outline = (changes: SpecChange[]) => changes.map((change) => `${change.kind}:${change.entityType}:${change.featureName}:${change.scenarioReference ?? ""}`);

describe("按身份配对：身份和名称一致时", () => {
  const before = [feature("A", [scenario("HP-1")]), feature("B", [scenario("HP-1"), scenario("HP-2")]), feature("C"), feature("D")];
  const after = [feature("A", [scenario("HP-1")]), feature("B", [scenario("HP-1"), scenario("HP-2", "Broken")]), feature("C", [], null, "C rewritten"), feature("E")];
  const beforeKeys = { a: "a", b: "b", c: "c", d: "d" };
  const afterKeys = { a: "a", b: "b", c: "c", e: "e" };

  it("gives exactly the result that pairing by name key gives, row for row and in the same order", () => {
    const byName = diffSpecWithFolded(before, after);
    const byIdentity = diffSpecWithFolded(before, after, { identities: { before: identities(beforeKeys), after: identities(afterKeys) } });
    expect(byIdentity).toEqual(byName);
    expect(outline(byIdentity.changes)).toEqual([
      "changed:scenario:B:HP-2",
      "uncertain:feature:D:",
      "added:feature:E:",
    ]);
    expect(compareDiffPairing(before, after, { identities: { before: identities(beforeKeys), after: identities(afterKeys) } }).same).toBe(true);
  });

  it("changes nothing when only one side has identities", () => {
    const byName = diffSpecWithFolded(before, after);
    expect(diffSpecWithFolded(before, after, { identities: { before: identities(beforeKeys), after: new Map() } })).toEqual(byName);
    expect(diffSpecWithFolded(before, after, { identities: { before: new Map(), after: identities(afterKeys) } })).toEqual(byName);
  });

  it("pairs by name key the features that lack an identity on either side", () => {
    // 乙在变更前那一侧没有身份（比如那一行是开关关着的时候写的）。它照旧按名称键和变更后的乙配上，
    // 场景的变化记成“变化”，而不是一个移除加一个新增。
    const before = [feature("甲", [scenario("HP-1")]), feature("乙", [scenario("HP-1")])];
    const after = [feature("甲", [scenario("HP-1", "Broken")]), feature("乙", [scenario("HP-1", "Broken")])];

    const result = diffSpecWithFolded(before, after, { identities: { before: identities({ 甲: "1" }), after: identities({ 甲: "1", 乙: "2" }) } });

    expect(outline(result.changes)).toEqual(["changed:scenario:乙:HP-1", "changed:scenario:甲:HP-1"]);
  });

  it("falls back to the name key when the same feature carries different identities on the two sides", () => {
    const before = [feature("甲", [scenario("HP-1")])];
    const after = [feature("甲", [scenario("HP-1", "Broken")])];

    const result = diffSpecWithFolded(before, after, { identities: { before: identities({ 甲: "1" }), after: identities({ 甲: "2" }) } });

    expect(outline(result.changes)).toEqual(["changed:scenario:甲:HP-1"]);
  });
});

describe("按身份配对：改了名的时候", () => {
  it("reports a rename as one changed row instead of a removal plus an addition", () => {
    const before = [feature("旧名字", [scenario("HP-1")])];
    const after = [feature("新名字", [scenario("HP-1")])];

    // 只看名称键：码点序里“新”排在“旧”前面。
    expect(outline(diffSpecWithFolded(before, after).changes)).toEqual(["added:feature:新名字:", "uncertain:feature:旧名字:"]);
    const renamed = diffSpecWithFolded(before, after, { identities: { before: identities({ 旧名字: "f1" }), after: identities({ 新名字: "f1" }) } });
    expect(outline(renamed.changes)).toEqual(["changed:feature:新名字:"]);
    expect(renamed.changes[0]).toMatchObject({ before: { name: "旧名字" }, after: { name: "新名字" } });
  });

  it("reports a scenario change inside a renamed feature under the new name", () => {
    const before = [feature("旧名字", [scenario("HP-1"), scenario("HP-2")])];
    const after = [feature("新名字", [scenario("HP-1", "Broken"), scenario("HP-2")])];

    const result = diffSpecWithFolded(before, after, { identities: { before: identities({ 旧名字: "f1" }), after: identities({ 新名字: "f1" }) } });

    expect(outline(result.changes)).toEqual(["changed:feature:新名字:", "changed:scenario:新名字:HP-1"]);
  });

  it("treats two features that swapped names as two renames, where names alone would show nothing", () => {
    const before = [feature("A", [scenario("HP-1")]), feature("B", [scenario("HP-1")])];
    const after = [feature("B", [scenario("HP-1")]), feature("A", [scenario("HP-1")])];

    expect(diffSpecWithFolded(before, after).changes).toEqual([]);
    const swapped = diffSpecWithFolded(before, after, { identities: { before: identities({ a: "1", b: "2" }), after: identities({ b: "1", a: "2" }) } });
    const namesOf = (value: SpecFeature | null | undefined) => (value && "name" in value ? value.name : null);
    expect(swapped.changes.map((change) => [namesOf(change.before as SpecFeature | null), namesOf(change.after as SpecFeature | null)])).toEqual([["A", "B"], ["B", "A"]]);
  });

  it("keeps the name key order: the renamed row sits where the feature used to be", () => {
    const before = [feature("A"), feature("B"), feature("C"), feature("D")];
    const after = [feature("A"), feature("Z", [], null, "B summary"), feature("C"), feature("E")];
    const keys = { a: "a", b: "b", c: "c", d: "d" };

    const result = diffSpecWithFolded(before, after, { identities: { before: identities(keys), after: identities({ a: "a", z: "b", c: "c", e: "e" }) } });

    expect(outline(result.changes)).toEqual(["changed:feature:Z:", "uncertain:feature:D:", "added:feature:E:"]);
  });

  it("does not let a rename hide the feature that had the new name before", () => {
    // 变更前有甲（身份 1）和乙（身份 2）；变更后甲改成了乙的名字，原来的乙不见了。
    const before = [feature("甲"), feature("乙")];
    const after = [feature("乙")];
    const result = diffSpecWithFolded(before, after, { identities: { before: identities({ 甲: "1", 乙: "2" }), after: identities({ 乙: "1" }) } });

    // 两行都挂在新名字下。改名的那一对排在它变更前的名称键“甲”的位置，排在“乙”的后面。
    expect(outline(result.changes)).toEqual(["uncertain:feature:乙:", "changed:feature:乙:"]);
    expect(result.changes[0]).toMatchObject({ before: { name: "乙" }, after: null });
    expect(result.changes[1]).toMatchObject({ before: { name: "甲" }, after: { name: "乙" } });
  });
});

  it("puts a rename ahead of a different feature that took over the vacated name", () => {
    // 变更前有甲（身份 1）；变更后甲改成了乙，同时另有一个功能用上了“甲”这个名字（身份 2）。
    // 两对的排序位置都是“甲”：有变更前功能的那一对，也就是改名，排在前面。
    const before = [feature("甲")];
    const after = [feature("甲"), feature("乙")];

    const result = diffSpecWithFolded(before, after, { identities: { before: identities({ 甲: "1" }), after: identities({ 甲: "2", 乙: "1" }) } });

    expect(outline(result.changes)).toEqual(["changed:feature:乙:", "added:feature:甲:"]);
    expect(result.changes[0]).toMatchObject({ before: { name: "甲" }, after: { name: "乙" } });
    expect(result.changes[1]).toMatchObject({ before: null, after: { name: "甲" } });
  });

describe("按身份配对与按名称键配对的对照", () => {
  it("says whether the two pairings give the same result and shows both", () => {
    const before = [feature("旧名字", [scenario("HP-1")])];
    const after = [feature("新名字", [scenario("HP-1")])];
    const identitiesOption = { identities: { before: identities({ 旧名字: "f1" }), after: identities({ 新名字: "f1" }) } };

    const comparison = compareDiffPairing(before, after, identitiesOption);

    expect(comparison.same).toBe(false);
    expect(outline(comparison.byName.changes)).toEqual(["added:feature:新名字:", "uncertain:feature:旧名字:"]);
    expect(outline(comparison.byIdentity.changes)).toEqual(["changed:feature:新名字:"]);
  });

  it("compares nothing when there is no version before", () => {
    const comparison = compareDiffPairing(null, [feature("A")], { identities: { before: new Map(), after: identities({ a: "a" }) } });
    expect(comparison.same).toBe(true);
    expect(comparison.byIdentity.changes).toEqual([]);
  });
});
