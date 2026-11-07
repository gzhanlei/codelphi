import { describe, expect, it } from "vitest";
import { renderProgressSummary, type ProgressRelease } from "../lib/progress-summary";

const base = { total: 3, added: 1, changed: 2, removed: 0 };

function release(overrides: Partial<ProgressRelease> = {}): ProgressRelease {
  return {
    id: 1,
    title: "发布变化页的发布卡片可折叠",
    summary: "发布变化页中每张发布卡片把回归清单与 AI 发布说明收进可折叠区域。",
    sha: "0273df8abc",
    url: "https://github.com/o/r/commit/0273df8abc",
    committedAt: new Date("2026-11-07T08:30:00Z"),
    ...base,
    ...overrides,
  };
}

describe("renderProgressSummary", () => {
  it("summarizes the window with totals and a per-release line", () => {
    const markdown = renderProgressSummary({
      productName: "CoDelphi",
      days: 7,
      releases: [release(), release({ id: 2, title: "窄推送回归验证注释", total: 1, added: 0, changed: 0, removed: 1, committedAt: new Date("2026-11-05T10:00:00Z"), sha: "20930c3abc", url: "https://github.com/o/r/commit/20930c3abc" })],
    });
    expect(markdown).toContain("# 进展摘要 · CoDelphi");
    expect(markdown).toContain("统计窗口：最近 7 天");
    expect(markdown).toContain("发布 2 次 · 行为变化 4 条（新增 1 · 变化 2 · 移除 1）");
    expect(markdown).toContain("[11-07] [发布变化页的发布卡片可折叠]");
    expect(markdown).toContain("行为变化 3 条：新增 1 · 变化 2 · 移除 0");
    expect(markdown).toContain("commit/0273df8abc");
  });

  it("keeps one line per release with title link and a short summary", () => {
    const markdown = renderProgressSummary({ productName: "CoDelphi", days: 7, releases: [release()] });
    expect(markdown).toMatch(/- \[11-07\] \[发布变化页的发布卡片可折叠\]\(https:\/\/github\.com\/o\/r\/commit\/0273df8abc\) — 发布变化页中每张发布卡片把回归清单与 AI 发布说明收进可折叠区域。（行为变化 3 条：新增 1 · 变化 2 · 移除 0）$/m);
  });

  it("states the empty window instead of an empty list", () => {
    const markdown = renderProgressSummary({ productName: "CoDelphi", days: 7, releases: [] });
    expect(markdown).toContain("统计窗口内没有发布");
  });
});
