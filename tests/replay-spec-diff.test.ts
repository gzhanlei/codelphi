import { describe, expect, it } from "vitest";
import { compareDiffPairing, type DiffPairingComparison, type SpecFeature } from "../lib/spec-diff";
import { pairingDifferences, parseReplayArgs, renderComparison } from "../scripts/replay-spec-diff";

const scenario = (reference: string, outcome = "Works") => ({ reference, context: "User", action: "Does it", outcome, category: "happy" as const, evidence: [] });
const feature = (name: string, scenarios: SpecFeature["scenarios"] = []): SpecFeature => ({ name, summary: `${name} summary`, parentKey: null, scenarios });
const identities = (keys: Record<string, string>) => new Map(Object.entries(keys));

/** 一对改了名的版本：按名称键和按身份配对的结果不同。 */
const renamed = (): DiffPairingComparison =>
  compareDiffPairing([feature("旧名字", [scenario("HP-1")])], [feature("新名字", [scenario("HP-1")])], { identities: { before: identities({ 旧名字: "f1" }), after: identities({ 新名字: "f1" }) } });

describe("回放工具的参数", () => {
  it("takes two version ids, an optional release id and the compare switch in either position", () => {
    expect(parseReplayArgs(["10", "11"])).toEqual({ beforeId: 10, afterId: 11, releaseId: null, compare: false });
    expect(parseReplayArgs(["10", "11", "6"])).toEqual({ beforeId: 10, afterId: 11, releaseId: 6, compare: false });
    expect(parseReplayArgs(["10", "11", "--compare"])).toEqual({ beforeId: 10, afterId: 11, releaseId: null, compare: true });
    expect(parseReplayArgs(["--compare", "10", "11", "6"])).toEqual({ beforeId: 10, afterId: 11, releaseId: 6, compare: true });
  });

  it("refuses what it does not understand instead of guessing a version", () => {
    expect(() => parseReplayArgs(["10"])).toThrow(/用法/);
    expect(() => parseReplayArgs([])).toThrow(/用法/);
    expect(() => parseReplayArgs(["10", "11", "6", "7"])).toThrow(/用法/);
    expect(() => parseReplayArgs(["10", "eleven"])).toThrow(/版本号/);
    expect(() => parseReplayArgs(["10", "11", "--force"])).toThrow(/不认识的参数/);
  });
});

describe("两种配对的对照", () => {
  it("says the pairings agree when they do", () => {
    const comparison = compareDiffPairing([feature("A", [scenario("HP-1")])], [feature("A", [scenario("HP-1", "Broken")])], { identities: { before: identities({ a: "a" }), after: identities({ a: "a" }) } });
    expect(pairingDifferences(comparison)).toEqual([]);
    expect(renderComparison(comparison)).toContain("两种配对逐项相同。");
    expect(renderComparison(comparison)).toContain("按名称键配对：行为变化 1 条，折叠 0 条");
  });

  it("lists the rows that only one pairing produces", () => {
    expect(pairingDifferences(renamed())).toEqual([
      "只按名称键配对时有：[变化] added:feature 新名字",
      "只按名称键配对时有：[变化] uncertain:feature 旧名字",
      "只按身份配对时有：[变化] changed:feature 新名字",
    ]);
    const text = renderComparison(renamed());
    expect(text).toContain("两种配对的结果不同：");
    expect(text).toContain("- 只按身份配对时有：[变化] changed:feature 新名字");
  });

  it("counts repeated rows: a row that appears twice on one side and once on the other is reported once", () => {
    const change = (kind: string, featureName: string, reference: string | null = null) => ({ kind, entityType: "feature", featureName, scenarioReference: reference, summary: "", before: null, after: null }) as never;
    const madeUp: DiffPairingComparison = {
      same: false,
      byName: { changes: [change("added", "B"), change("added", "B")], folded: [] },
      byIdentity: { changes: [change("added", "B")], folded: [] },
    };

    expect(pairingDifferences(madeUp)).toEqual(["只按名称键配对时有：[变化] added:feature B"]);
  });
});
