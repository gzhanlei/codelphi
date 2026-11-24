import { describe, expect, it } from "vitest";
import { toLedgerLine } from "../scripts/incremental-trial-ledger-export";

const release = { repository_id: 8, sha: "9bfd6c0", spec_version_id: 311 };

describe("可用率试验的账本导出", () => {
  it("keeps automatic features and their evidence anchors, and leaves out manual entries and scenario text", () => {
    const line = toLedgerLine(
      release,
      [
        { id: 1, stable_key: "a", source: "generated" },
        { id: 2, stable_key: "m", source: "manual" },
        { id: 3, stable_key: "b", source: "ai_snapshot_import" },
      ],
      [
        {
          spec_feature_id: 1,
          source: "generated",
          evidence: JSON.stringify([{ path: "lib/a.ts", startLine: 3, endLine: 9, note: "不该被导出" }, { path: "README.md" }]),
        },
        // 自动功能下被用户改成了 manual 的场景，以及 manual 功能下的场景：都不属于自动证据。
        { spec_feature_id: 1, source: "manual", evidence: [{ path: "lib/manual.ts", startLine: 1 }] },
        { spec_feature_id: 2, source: "generated", evidence: [{ path: "lib/m.ts", startLine: 1 }] },
        { spec_feature_id: 3, source: "ai_snapshot_import", evidence: [{ path: "lib/b.ts", startLine: 5 }] },
        { spec_feature_id: 3, source: "ai_snapshot_import", evidence: [{ note: "没有路径的条目不算锚点" }] },
      ],
    );
    expect(line).toEqual({
      repositoryId: 8,
      sha: "9bfd6c0",
      versionId: 311,
      features: [
        [1, "a"],
        [3, "b"],
      ],
      anchors: [
        ["a", "lib/a.ts", 3, 9],
        ["a", "README.md", null, null],
        ["b", "lib/b.ts", 5, 5],
      ],
    });
  });

  it("skips a release that has no spec version", () => {
    expect(toLedgerLine({ ...release, spec_version_id: null }, [], [])).toBeNull();
  });
});
