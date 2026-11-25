import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadReleasePage } from "../lib/product-details";

const { execute, diffSpy } = vi.hoisted(() => ({ execute: vi.fn(), diffSpy: vi.fn() }));
vi.mock("../lib/db", () => ({ getDb: () => ({ execute }), defaultExecute: execute }));
// 只包一层记录：比对本 itself 还是真实实现，这样能断言“传了什么进去”和“结果因此有什么不同”。
vi.mock("../lib/spec-diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/spec-diff")>();
  return { ...actual, diffSpecWithFolded: diffSpy.mockImplementation(actual.diffSpecWithFolded) };
});

const release = { id: 6, title: "v1", summary: "Release", sha: "abc", url: "https://github.com/commit/abc", committedAt: new Date("2026-11-01T00:00:00Z"), specVersionId: 3 };
const scenarioRow = (versionId: number, context: string) => ({ versionId, featureId: 5, reference: "HP-1", context, action: "Signs in", outcome: "Dashboard", category: "happy", source: "generated", evidence: "[]" });

/**
 * 一次发布前后的两个版本：功能从“旧名字”改成了“新名字”，场景只多了一个空格。
 * withIdentities 为 false 时，身份列还是空的（身份层之前写下的版本，或者还没回填）。
 */
function answer(withIdentities: boolean) {
  return async (sql: string = "") => {
    if (sql.includes("SELECT id FROM products WHERE slug")) return [[{ id: 4 }]];
    if (sql.includes("FROM repositories WHERE product_id")) return [[{ owner: "gzhanlei", name: "radar" }]];
    if (sql.includes("FROM analysis_runs r")) return [[]];
    if (sql.includes("AS specVersionId FROM releases")) return [[release]];
    if (sql.includes("SELECT COUNT(*) AS total FROM releases")) return [[{ total: 1 }]];
    if (sql.includes("AS baseVersionId")) return [[{ versionId: 3, baseVersionId: 2 }]];
    if (sql.includes("identity_key FROM spec_features WHERE spec_version_id IN")) {
      return withIdentities ? [[{ versionId: 2, nameKey: "旧名字", identity_key: "f1" }, { versionId: 3, nameKey: "新名字", identity_key: "f1" }]] : [[]];
    }
    if (sql.includes("ss.identity_key")) return [[]];
    if (sql.includes("FROM spec_features WHERE spec_version_id IN")) {
      return [[{ id: 5, versionId: 2, name: "旧名字", summary: "OAuth", parentKey: null, source: "generated" }, { id: 5, versionId: 3, name: "新名字", summary: "OAuth", parentKey: null, source: "generated" }]];
    }
    if (sql.includes("FROM spec_scenarios ss JOIN")) return [[scenarioRow(2, "Visitor signs in"), scenarioRow(3, "Visitor  signs in")]];
    return [[]];
  };
}

describe("release page recompute with identities", () => {
  beforeEach(() => {
    diffSpy.mockClear();
  });

  it("hands the two versions' identities to the diff, read in one query", async () => {
    execute.mockImplementation(answer(true));

    await loadReleasePage("radar", 7, 0, 10);

    const call = diffSpy.mock.calls.find(([, after]) => (after as Array<{ name: string }>).some((feature) => feature.name === "新名字"));
    expect(call?.[2]).toMatchObject({ identities: { before: new Map([["旧名字", "f1"]]), after: new Map([["新名字", "f1"]]) } });
    const identityQueries = execute.mock.calls.filter(([sql]) => String(sql).includes("identity_key FROM spec_features WHERE spec_version_id IN"));
    expect(identityQueries.map(([, parameters]) => [...parameters].sort())).toEqual([[2, 3]]);
  });

  it("keeps a wording-only change inside a renamed feature as a folded row under the new name", async () => {
    execute.mockImplementation(answer(true));

    const page = await loadReleasePage("radar", 7, 0, 10);

    expect(page?.foldedChanges).toEqual([expect.objectContaining({ entityType: "scenario", featureName: "新名字", scenarioReference: "HP-1", reason: "wording" })]);
  });

  it("falls back to name keys when the versions carry no identities, so the row is not folded", async () => {
    execute.mockImplementation(answer(false));

    const page = await loadReleasePage("radar", 7, 0, 10);

    // 只看名称键，这是一个功能被移除、另一个被新增：中间那个场景的措辞变化无从谈起。
    expect(page?.foldedChanges).toEqual([]);
    const call = diffSpy.mock.calls.find(([, after]) => (after as Array<{ name: string }>).some((feature) => feature.name === "新名字"));
    expect(call?.[2]).toMatchObject({ identities: { before: new Map(), after: new Map() } });
  });
});
