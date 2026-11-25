import { describe, expect, it } from "vitest";
import type { ExportedVersion } from "../scripts/verify-spec-identity";
import { chainsOf, diffIdentities, diffSets, diffStates, expectedState, parseArgs, scratchDatabase, type LedgerState, type VersionRows } from "../scripts/verify-spec-identity-mysql";

const scenarioKey = (feature: string, reference: string) => JSON.stringify([feature, reference]);
const URL_WITH = (database: string) => `mysql://user:pass@127.0.0.1:3306/${database}`;

// 不对称的一条链：功能时有时无、有子功能、有改名；仓库 4 和仓库 3 同属一个产品。
function ledger() {
  let nextId = 1;
  const feature = (name: string, parentKey: string | null = null) => ({ id: nextId++, name, summary: `Summary of ${name}`, parentKey, source: "generated" as const, position: 0 });
  const scenario = (featureId: number, reference: string) => ({ id: nextId++, featureId, reference, context: "User", action: "Uses it", outcome: "Works", category: "happy", step: null, source: "generated" as const });
  const change = (featureKey: string, scenarioReference: string) => ({ id: nextId++, entityType: "feature", kind: "added", featureKey, featureName: featureKey, scenarioReference, baseSpecVersionId: null });
  const version = (id: number, repositoryId: number, features: ReturnType<typeof feature>[], scenarios: ReturnType<typeof scenario>[], changes: ReturnType<typeof change>[] = []): ExportedVersion => ({ id, repositoryId, productId: 7, sha: `sha-${id}`, analysisRunId: id, baseSpecVersionId: null, features, scenarios, changes });

  const a1 = feature("A");
  const a2 = feature("B");
  const a3 = feature("A child", "a");
  const a1s1 = scenario(a1.id, "HP-1");
  const a1s2 = scenario(a1.id, "HP-2");
  const a2s1 = scenario(a2.id, "HP-1");
  const c1 = change("a", "");
  const b1 = feature("A");
  const b2 = feature("C");
  const b1s1 = scenario(b1.id, "HP-1");
  const b1s2 = scenario(b1.id, "HP-2");
  const b2s1 = scenario(b2.id, "HP-1");
  const c2 = change("b", "HP-1");
  const d1 = feature("A");
  const d2 = feature("B");
  const d3 = feature("C2");
  const d1s1 = scenario(d1.id, "HP-1");
  const d2s1 = scenario(d2.id, "HP-1");
  const d3s1 = scenario(d3.id, "HP-1");
  const e1 = feature("A");
  const e1s1 = scenario(e1.id, "HP-1");
  const versions = [
    version(10, 3, [a1, a2, a3], [a1s1, a1s2, a2s1], [c1]),
    version(11, 3, [b1, b2], [b1s1, b1s2, b2s1], [c2]),
    version(12, 3, [d1, d2, d3], [d1s1, d2s1, d3s1]),
    version(20, 4, [e1], [e1s1]),
  ];
  return { versions, ids: { a1, a2, a3, a1s1, a1s2, a2s1, c1, c2, d1, d2, d3 } };
}

type Values = (string | null)[];

/** 空的全貌：三个版本表都还没有身份。测试里按需往里放行。 */
function state(versions: readonly ExportedVersion[]) {
  const rows = new Map<number, VersionRows>(
    versions.map((version) => [version.id, { features: new Map<number, Values>(), scenarios: new Map<number, Values>(), changes: new Map<number, Values>() }]),
  );
  return { versions: rows, registry: new Set<string>(["registry a"]), links: new Set<string>(["link a"]) };
}

describe("scratchDatabase", () => {
  it("accepts a database whose name starts with the scratch prefix", () => {
    expect(scratchDatabase(URL_WITH("codelphi_test_spec_identity"))).toBe("codelphi_test_spec_identity");
    expect(scratchDatabase(URL_WITH("codelphi_test_spec_identity_2026_11_25"))).toBe("codelphi_test_spec_identity_2026_11_25");
  });

  it("refuses anything else, because the script drops and recreates the database", () => {
    for (const database of ["codelphi", "codelphi_test", "codelphi_test_identity", "xcodelphi_test_spec_identity", "Codelphi_test_spec_identity", "codelphi_test_spec_identity/other", ""]) {
      expect(() => scratchDatabase(URL_WITH(database))).toThrow(/库名必须以 codelphi_test_spec_identity 开头/);
    }
  });

  it("refuses an address that is not a mysql URL", () => {
    expect(() => scratchDatabase("postgres://user:pass@127.0.0.1/codelphi_test_spec_identity")).toThrow(/库名必须以/);
    expect(() => scratchDatabase("not a url")).toThrow(/不是合法的连接地址/);
  });
});

describe("parseArgs", () => {
  it("takes the ledger path and the two switches", () => {
    expect(parseArgs(["--ledger", "ledger.jsonl", "--keep", "--md5-stand-in"])).toEqual({ ledgerPath: "ledger.jsonl", keep: true, md5StandIn: true });
    expect(parseArgs(["--ledger", "ledger.jsonl"])).toEqual({ ledgerPath: "ledger.jsonl", keep: false, md5StandIn: false });
  });

  it("requires the ledger path and rejects unknown arguments", () => {
    expect(() => parseArgs([])).toThrow(/--ledger/);
    expect(() => parseArgs(["--ledger"])).toThrow(/--ledger/);
    expect(() => parseArgs(["--ledger", "a.jsonl", "--apply"])).toThrow(/不认识「--apply」/);
  });
});

describe("expectedState", () => {
  const { versions, ids } = ledger();
  const expected = expectedState(chainsOf(versions));

  it("groups the versions of each repository and orders them by version number", () => {
    const chains = chainsOf([...versions].reverse());
    expect([...chains.keys()].sort()).toEqual([3, 4]);
    expect(chains.get(3)?.map((version) => version.id)).toEqual([10, 11, 12]);
    expect(chains.get(4)?.map((version) => version.id)).toEqual([20]);
  });

  it("walks the repositories by number whatever order the ledger lists them in", () => {
    // 登记表按产品共用，先走哪个仓库决定身份记在哪个版本上（下面一条测试钉的是记在版本 10 而不是 20）。
    expect(expectedState(chainsOf([...versions].reverse()))).toEqual(expectedState(chainsOf(versions)));
  });

  it("puts the first-appearance name key on every row of the first version", () => {
    expect(expected.versions.get(10)).toEqual({
      features: new Map([
        [ids.a1.id, ["a", null]],
        [ids.a2.id, ["b", null]],
        [ids.a3.id, ["a child", "a"]],
      ]),
      scenarios: new Map([
        [ids.a1s1.id, [scenarioKey("a", "HP-1")]],
        [ids.a1s2.id, [scenarioKey("a", "HP-2")]],
        [ids.a2s1.id, [scenarioKey("b", "HP-1")]],
      ]),
      changes: new Map([[ids.c1.id, ["a", null]]]),
    });
  });

  it("resolves the change row of a removed entry against the previous version", () => {
    expect(expected.versions.get(11)?.changes).toEqual(new Map([[ids.c2.id, ["b", scenarioKey("b", "HP-1")]]]));
  });

  it("keeps a continued identity, restores a retired one and mints a renamed one", () => {
    expect(expected.versions.get(12)?.features).toEqual(
      new Map([
        [ids.d1.id, ["a", null]],
        [ids.d2.id, ["b", null]],
        [ids.d3.id, ["c2", null]],
      ]),
    );
  });

  it("records each identity once per product, at the version where it first appeared", () => {
    expect(expected.registry).toEqual(
      new Set([
        JSON.stringify(["feature_identities", 7, "a", "A", 10]),
        JSON.stringify(["feature_identities", 7, "b", "B", 10]),
        JSON.stringify(["feature_identities", 7, "a child", "A child", 10]),
        JSON.stringify(["feature_identities", 7, "c", "C", 11]),
        JSON.stringify(["feature_identities", 7, "c2", "C2", 12]),
        JSON.stringify(["scenario_identities", 7, scenarioKey("a", "HP-1"), "a", "HP-1", 10]),
        JSON.stringify(["scenario_identities", 7, scenarioKey("a", "HP-2"), "a", "HP-2", 10]),
        JSON.stringify(["scenario_identities", 7, scenarioKey("b", "HP-1"), "b", "HP-1", 10]),
        JSON.stringify(["scenario_identities", 7, scenarioKey("c", "HP-1"), "c", "HP-1", 11]),
        JSON.stringify(["scenario_identities", 7, scenarioKey("c2", "HP-1"), "c2", "HP-1", 12]),
      ]),
    );
  });

  it("records a retire link and a restore link for features and their scenarios", () => {
    expect(expected.links).toEqual(
      new Set([
        JSON.stringify(["feature_identity_links", 11, "retire", "a child"]),
        JSON.stringify(["feature_identity_links", 11, "retire", "b"]),
        JSON.stringify(["scenario_identity_links", 11, "retire", scenarioKey("b", "HP-1")]),
        JSON.stringify(["feature_identity_links", 12, "retire", "c"]),
        JSON.stringify(["scenario_identity_links", 12, "retire", scenarioKey("a", "HP-2")]),
        JSON.stringify(["scenario_identity_links", 12, "retire", scenarioKey("c", "HP-1")]),
        JSON.stringify(["feature_identity_links", 12, "restore", "b"]),
        JSON.stringify(["scenario_identity_links", 12, "restore", scenarioKey("b", "HP-1")]),
        JSON.stringify(["feature_identity_links", 20, "restore", "a"]),
        JSON.stringify(["scenario_identity_links", 20, "restore", scenarioKey("a", "HP-1")]),
      ]),
    );
  });
});

describe("diffIdentities", () => {
  it("returns nothing when every row carries the expected columns", () => {
    const rows: Map<number, (string | null)[]> = new Map([
      [7, ["a", null]],
      [8, ["b", "p"]],
    ]);
    expect(diffIdentities("spec_features", rows, new Map(rows))).toEqual([]);
  });

  it("names the row when an identity is missing, different, or unexpected", () => {
    const expected: Map<number, string[]> = new Map([[7, ["a", "p"]]]);
    expect(diffIdentities("spec_features", expected, new Map([[7, ["a", null]]]))).toEqual(["spec_features 行 7：应为 [a, p]，库里是 [a, ]"]);
    expect(diffIdentities("spec_features", expected, new Map([[7, ["x", "p"]]]))).toEqual(["spec_features 行 7：应为 [a, p]，库里是 [x, p]"]);
    expect(diffIdentities("spec_features", expected, new Map())).toEqual(["spec_features 行 7：库里没有这一行"]);
    expect(diffIdentities("spec_features", new Map(), new Map([[9, ["x"]]]))).toEqual(["spec_features 行 9：离线算出来这一行不该有身份，库里有 [x]"]);
  });

  it("lists at most the given number of differences", () => {
    const expected = new Map(Array.from({ length: 7 }, (_, index) => [index, ["a"]]));
    expect(diffIdentities("spec_scenarios", expected, new Map())).toHaveLength(5);
    expect(diffIdentities("spec_scenarios", expected, new Map(), 2)).toHaveLength(2);
  });
});

describe("diffSets", () => {
  it("returns nothing for the same rows and names what is missing or extra", () => {
    expect(diffSets("登记表", new Set(["a", "b"]), new Set(["b", "a"]))).toEqual([]);
    expect(diffSets("登记表", new Set(["a", "b"]), new Set(["b", "c"]))).toEqual(["登记表：缺 a", "登记表：多 c"]);
    expect(diffSets("关系表", new Set(), new Set(["1", "2", "3"]), 2)).toHaveLength(2);
  });
});

describe("diffStates", () => {
  it("returns nothing for the same state", () => {
    expect(diffStates(state([ledger().versions[0]]), state([ledger().versions[0]]))).toEqual([]);
  });

  it("reports a version the database does not have, a changed row, and registry and link rows", () => {
    const { versions, ids } = ledger();
    const expected = state([versions[0]]);
    const actual: LedgerState = { ...state([versions[1], versions[2]]), registry: new Set(), links: new Set() };
    expect(diffStates(expected, actual, 10)).toEqual(["版本：缺 10", "版本：多 11", "版本：多 12", "登记表：缺 registry a", "关系表：缺 link a"]);
    expect(diffStates(expected, { ...expected, links: new Set(["link b"]) }, 10)).toEqual(["关系表：缺 link a", "关系表：多 link b"]);
    // limit 管的是最后交出去的总条数，不是每张表各几条。
    expect(diffStates(expected, { ...expected, registry: new Set(["other"]), links: new Set(["other"]) }, 2)).toEqual(["登记表：缺 registry a", "登记表：多 other"]);
  });

  it("compares the rows of a version it has on both sides", () => {
    const { versions, ids } = ledger();
    const expected = state([versions[0]]);
    const actual = state([versions[0]]);
    // state() 里三个版本表都是空的，这里换成带一行的。
    expected.versions.set(10, { ...expected.versions.get(10)!, features: new Map<number, Values>([[ids.a1.id, ["a", null]]]) });
    actual.versions.set(10, { ...actual.versions.get(10)!, features: new Map<number, Values>([[ids.a1.id, ["x", null]]]) });
    expect(diffStates(expected, actual)).toEqual([`features（版本 10） 行 ${ids.a1.id}：应为 [a, ]，库里是 [x, ]`]);
    // 另外两张表一样，不报。
    expect(diffStates(expected, actual)).toHaveLength(1);
  });
});
