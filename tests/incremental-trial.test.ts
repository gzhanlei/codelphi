import { describe, expect, it } from "vitest";
import type { FileImpact } from "../lib/impact-classification";
import { GOLDEN_CATEGORIES, isImplementationSource, parseLedger, selectGoldenWindows, toFileRows, type GoldenCandidate, type TrialFileRow } from "../lib/incremental-trial";

const noStale = { stale: 0, touched: 0, nonBehavioralTouched: 0 };

function fileRow(path: string, overrides: Partial<TrialFileRow> = {}): TrialFileRow {
  return { path, oldPath: null, status: "modified", classification: "direct", reason: "indexed_implementation", directFeatureKeys: [], ...overrides };
}

describe("账本导出文件解析", () => {
  const jsonl = [
    JSON.stringify({
      repositoryId: 8,
      sha: "bbbb",
      versionId: 2,
      features: [
        [1, "a"],
        [2, "b"],
      ],
      anchors: [
        ["a", "lib/a.ts", 3, 9],
        ["a", "README.md", 1, 1],
        ["b", "lib/a.ts", 20, 20],
        ["a", "lib/a.ts", 30, 30],
      ],
    }),
    JSON.stringify({ repositoryId: 8, sha: "cccc", versionId: 3, features: [[1, "a"]], anchors: [] }),
    JSON.stringify({ repositoryId: 11, sha: "xxxx", versionId: 9, features: [[5, "r"]], anchors: [["r", "src/main.ts", 1, 1]] }),
    "",
  ].join("\n");

  it("groups releases by repository in release order and builds each baseline's index", () => {
    const ledger = parseLedger(jsonl);
    expect([...ledger.keys()]).toEqual([8, 11]);
    const releases = ledger.get(8) ?? [];
    expect(releases.map((release) => release.sha)).toEqual(["bbbb", "cccc"]);
    expect(releases[0].baseline.featureKeys).toEqual(["a", "b"]);
    expect(releases[0].baseline.pathFeatures.get("lib/a.ts")).toEqual(["a", "b"]);
    expect(releases[0].baseline.pathFeatures.get("README.md")).toEqual(["a"]);
    expect(releases[0].baseline.featurePaths.get("a")).toEqual(["README.md", "lib/a.ts"]);
    expect(releases[0].baseline.anchors).toHaveLength(4);
    expect(releases[0].baseline.anchors[0]).toEqual({ featureKey: "a", path: "lib/a.ts", startLine: 3, endLine: 9 });
  });

  const valid = JSON.stringify({ repositoryId: 8, sha: "aaaa", versionId: 1, features: [], anchors: [] });

  it("refuses a line that is not JSON instead of silently dropping it", () => {
    expect(() => parseLedger(`${valid}\nnot json\n`)).toThrow(/第 2 行不是合法的 JSON/);
  });

  it("refuses a line whose fields are missing or malformed", () => {
    expect(() => parseLedger(`${valid}\n{"repositoryId":8}\n`)).toThrow(/第 2 行的字段不完整/);
    expect(() => parseLedger(`${valid}\n${JSON.stringify({ repositoryId: 8, sha: "b", versionId: 2, features: [], anchors: [["a", "lib/a.ts", 1]] })}\n`)).toThrow(
      /第 2 行的字段不完整/,
    );
    // 合法的 JSON 但根本不是对象：同样报字段不完整，而不是在深处抛一个看不出处的类型错误。
    expect(() => parseLedger(`${valid}\nnull\n`)).toThrow(/第 2 行的字段不完整/);
    expect(() => parseLedger(`${valid}\n42\n`)).toThrow(/第 2 行的字段不完整/);
  });
});

describe("哪些文件算实现源码", () => {
  it.each([
    ["lib/a.ts", true],
    ["app/api/x/route.ts", true],
    ["components/Button.tsx", true],
    ["README.md", false],
    ["docs/index.tsx", false],
    ["tests/x.test.ts", false],
    [".github/workflows/ci.yml", false],
    ["package-lock.json", false],
    ["yarn.lock", false],
  ])("%s → %s", (path, expected) => {
    expect(isImplementationSource(path)).toBe(expected);
  });
});

describe("窗口里的文件记录", () => {
  it("keeps direct feature keys only for entries that need analysis", () => {
    const files = [
      { path: "lib/a.ts", oldPath: null, status: "modified", classification: "direct", reason: "indexed_implementation", directFeatureKeys: ["a"] },
      { path: "README.md", oldPath: null, status: "modified", classification: "no_behavior", reason: "document" },
    ] as FileImpact[];
    expect(toFileRows(files)).toEqual([
      { path: "lib/a.ts", oldPath: null, status: "modified", classification: "direct", reason: "indexed_implementation", directFeatureKeys: ["a"] },
      { path: "README.md", oldPath: null, status: "modified", classification: "no_behavior", reason: "document", directFeatureKeys: [] },
    ]);
  });
});

describe("挑选 Golden Repository 的冻结窗口", () => {
  const row = (overrides: Partial<GoldenCandidate>): GoldenCandidate => ({
    files: [fileRow("lib/a.ts")],
    outcome: "direct",
    reanalyzedFeatures: 1,
    newImplementationFiles: 0,
    fastPath: noStale,
    ...overrides,
  });

  it("takes the first window in release order for every category it can recognise", () => {
    const readmeFirst = row({ files: [fileRow("README.md", { classification: "no_behavior", reason: "document" })], outcome: "no_behavior", reanalyzedFeatures: 0 });
    const migration = row({ files: [fileRow("migrations/1.sql", { classification: "global_unbounded", reason: "schema_migration" })], outcome: "global_unbounded" });
    const rename = row({
      files: [fileRow("lib/new.ts", { oldPath: "lib/old.ts", status: "renamed", classification: "no_detected_behavior_change", reason: "pure_rename" })],
      outcome: "no_detected_behavior_change",
      reanalyzedFeatures: 0,
    });
    const selected = selectGoldenWindows([readmeFirst, migration, rename]);
    expect(selected.readme_only).toBe(readmeFirst);
    expect(selected.schema_migration).toBe(migration);
    expect(selected.pure_rename).toBe(rename);
    expect(selected.tests_only).toBeNull();
    expect(selected.assembly_point).toBeNull();
  });

  it("does not mistake a window with other changes for a tests-only or README-only window", () => {
    const mixed = row({
      files: [fileRow("README.md", { classification: "no_behavior", reason: "document" }), fileRow("lib/a.ts")],
      outcome: "direct",
    });
    expect(selectGoldenWindows([mixed]).readme_only).toBeNull();
  });

  it("does not take an empty window for a tests-only or README-only window", () => {
    const empty = row({ files: [], outcome: "no_detected_behavior_change", reanalyzedFeatures: 0 });
    const selected = selectGoldenWindows([empty]);
    expect(selected.tests_only).toBeNull();
    expect(selected.readme_only).toBeNull();
  });

  it("names every category that has to be covered", () => {
    const ids = GOLDEN_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["shared_utility", "assembly_point", "schema_migration", "rename_with_content", "unindexed_implementation"]));
    expect(Object.keys(selectGoldenWindows([]))).toEqual(ids);
  });
});
