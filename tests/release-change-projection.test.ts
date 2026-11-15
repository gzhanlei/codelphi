import { describe, expect, it, vi } from "vitest";
import { buildReleaseChangeProjections, rewriteReleaseChangeProjections, type ReleaseChangeFact } from "../lib/release-change-projection";

function fact(id: number, featureName: string, summary: string, kind: ReleaseChangeFact["kind"] = "changed"): ReleaseChangeFact {
  return {
    id,
    kind,
    entityType: "scenario",
    featureName,
    scenarioReference: `EC-${id}`,
    summary,
    before: null,
    after: {
      reference: `EC-${id}`,
      context: "上下文",
      action: "操作",
      outcome: "结果",
      category: "edge",
      evidence: [{ path: "lib/spec-diff.ts", startLine: 300 + id }],
    },
  };
}

const release229Summaries = [
  "散文中的「≥1 对」「5 个」等数字噪声不再阻断变体折叠，而「变更0」与「独立变更0」这类短标题不再被误折。",
  "散文里的个位数计数不再阻止同一行为的措辞变体折叠；「变更0」与「独立变更0」这类短标题不再被误折；404 与 400 等多位错误码仍被守护。",
  "散文里的个位数计数不再导致同一变化被误判为不同条目；「变更0」与「独立变更0」这类短标题不再被误折。",
];

describe("buildReleaseChangeProjections", () => {
  it("builds one source-linked projection per canonical feature regardless of wording", () => {
    const facts = [
      ...release229Summaries.map((summary, index) => fact(index + 1, "变化条目措辞变体判定", summary)),
      fact(4, "发布变化存量去重脚本", "保留独立功能的另一项变化"),
    ];

    const projections = buildReleaseChangeProjections(facts);

    expect(projections).toHaveLength(2);
    expect(projections[0]).toMatchObject({
      featureName: "变化条目措辞变体判定",
      kind: "changed",
      sourceSpecChangeIds: [1, 2, 3],
    });
    expect(projections[0].description).toContain(release229Summaries[0]);
    expect(projections[0].description).toContain(release229Summaries[1]);
    expect(projections[0].description).toContain(release229Summaries[2]);
    expect(projections[0].userImpact).toBe("");
    expect(projections[0].evidence).toEqual([
      { path: "lib/spec-diff.ts", startLine: 301 },
      { path: "lib/spec-diff.ts", startLine: 302 },
      { path: "lib/spec-diff.ts", startLine: 303 },
    ]);
    expect(projections[1].sourceSpecChangeIds).toEqual([4]);
  });

  it("keeps mixed added and removed facts in one audit projection without dropping either", () => {
    const [projection] = buildReleaseChangeProjections([
      fact(10, "登录", "新增邮箱登录", "added"),
      fact(11, "登录", "移除旧令牌登录", "removed"),
    ]);

    expect(projection.kind).toBe("changed");
    expect(projection.sourceSpecChangeIds).toEqual([10, 11]);
    expect(projection.description).toContain("新增邮箱登录");
    expect(projection.description).toContain("移除旧令牌登录");
  });

  it("truncates oversized fallback copy at a complete sentence boundary", () => {
    const first = `${"甲".repeat(3_998)}。`;
    const [projection] = buildReleaseChangeProjections([
      fact(1, "长描述", first),
      fact(2, "长描述", `${"乙".repeat(20)}。`),
    ]);

    expect(projection.description).toBe(first);
    expect(projection.description).toHaveLength(3_999);
    expect(projection.description.endsWith("。")).toBe(true);
  });
});

describe("rewriteReleaseChangeProjections", () => {
  it("updates only copy on the persisted projection and leaves source identity unchanged", async () => {
    const projection = { ...buildReleaseChangeProjections([fact(1, "变化条目措辞变体判定", release229Summaries[0])])[0], changeId: 99 };
    const execute = vi.fn(async () => ({}));
    const completion = vi.fn(async (_messages: Array<{ role: string; content: string }>) => JSON.stringify({ description: "统一修复变化条目判定", userImpact: "同一修复只展示一次。" }));

    const result = await rewriteReleaseChangeProjections(
      { execute },
      { completion, runId: 7, accountId: 3 },
      [projection],
    );

    expect(result).toEqual({ rewritten: 1, failed: 0, skipped: 0 });
    expect(execute).toHaveBeenCalledWith("UPDATE changes SET description = ?, user_impact = ? WHERE id = ?", ["统一修复变化条目判定", "同一修复只展示一次。", 99]);
    expect(projection.sourceSpecChangeIds).toEqual([1]);
    expect(completion.mock.calls[0][0][1].content).toContain("spec_change #1");
  });

  it("keeps deterministic fallback copy when AI output is malformed", async () => {
    const projection = { ...buildReleaseChangeProjections([fact(1, "变化条目措辞变体判定", release229Summaries[0])])[0], changeId: 99 };
    const execute = vi.fn(async () => ({}));

    const result = await rewriteReleaseChangeProjections(
      { execute },
      { completion: vi.fn(async () => "not json"), runId: 7, accountId: 3 },
      [projection],
    );

    expect(result).toEqual({ rewritten: 0, failed: 1, skipped: 0 });
    expect(execute).not.toHaveBeenCalled();
    expect(projection.description).toBe(release229Summaries[0]);
  });

  it("caps AI rewrites per run and keeps remaining projections deterministic", async () => {
    const projections = Array.from({ length: 13 }, (_, index) => ({
      ...buildReleaseChangeProjections([fact(index + 1, `功能${index + 1}`, `事实${index + 1}`)])[0],
      changeId: index + 1,
    }));
    const execute = vi.fn(async () => ({}));
    const completion = vi.fn(async () => JSON.stringify({ description: "润色", userImpact: "影响" }));

    const result = await rewriteReleaseChangeProjections(
      { execute },
      { completion, runId: 7, accountId: 3 },
      projections,
    );

    expect(result).toEqual({ rewritten: 12, failed: 0, skipped: 1 });
    expect(completion).toHaveBeenCalledTimes(12);
    expect(execute).not.toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([13]));
    expect(projections[12].description).toBe("事实13");
  });
});
