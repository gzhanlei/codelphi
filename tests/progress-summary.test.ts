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
    regime: "anchored",
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

  it("adds the capability-increment section when feature deltas are present", () => {
    const markdown = renderProgressSummary({
      productName: "CoDelphi",
      days: 30,
      releases: [release()],
      featureDeltas: [
        { featureName: "规格导出", scenariosAdded: 3, scenariosChanged: 2, scenariosRemoved: 1 },
        { featureName: "统一登录", scenariosAdded: 0, scenariosChanged: 4, scenariosRemoved: 0 },
      ],
    });
    expect(markdown).toContain("## 能力进展（按功能聚合）");
    expect(markdown).toContain("- 规格导出：新增 3 个场景，更新 2 个场景，移除 1 个场景，净 +2 个场景");
    expect(markdown).toContain("- 统一登录：更新 4 个场景");
    expect(markdown).toContain("## 发布明细");
    expect(markdown).toContain("[11-07] [发布变化页的发布卡片可折叠]");
  });

  it("leads the capability line with the new scenario references and caps the list", () => {
    const markdown = renderProgressSummary({
      productName: "CoDelphi",
      days: 30,
      releases: [release()],
      featureDeltas: [
        { featureName: "规格导出", scenariosAdded: 3, scenariosChanged: 0, scenariosRemoved: 1, addedReferences: ["EC-1", "EC-2", "HP-4"] },
        { featureName: "发布通知渠道", scenariosAdded: 5, scenariosChanged: 0, scenariosRemoved: 0, addedReferences: ["NT-1", "NT-1", "NT-2", "NT-3", "NT-4", "NT-5"] },
      ],
    });
    expect(markdown).toContain("- 规格导出：新增场景 EC-1、EC-2、HP-4，移除 1 个场景，净 +2 个场景");
    expect(markdown).toContain("- 发布通知渠道：新增场景 NT-1、NT-2、NT-3 等，净 +5 个场景");
    expect(markdown).not.toContain("NT-4");
  });

  it("omits the aggregation section when deltas are absent or all-zero", () => {
    const withoutDeltas = renderProgressSummary({ productName: "CoDelphi", days: 7, releases: [release()] });
    expect(withoutDeltas).not.toContain("能力进展");
    const allZero = renderProgressSummary({ productName: "CoDelphi", days: 7, releases: [release()], featureDeltas: [{ featureName: "规格导出", scenariosAdded: 0, scenariosChanged: 0, scenariosRemoved: 0 }] });
    expect(allZero).not.toContain("能力进展");
  });

  it("notes the overflow instead of listing every feature", () => {
    const deltas = Array.from({ length: 25 }, (_, index) => ({ featureName: `功能${index}`, scenariosAdded: 1, scenariosChanged: 0, scenariosRemoved: 0 }));
    const markdown = renderProgressSummary({ productName: "CoDelphi", days: 30, releases: [release()], featureDeltas: deltas });
    expect(markdown).toContain("其余 5 个功能有零星变化");
    expect(markdown).not.toContain("功能24：");
  });

  it("adds the regime annotation when pre-anchor rebuild counts dominate the window", () => {
    const markdown = renderProgressSummary({
      productName: "CoDelphi",
      days: 7,
      releases: [release({ total: 77, added: 8, changed: 63, removed: 6, regime: "rebuild" }), release({ id: 2, title: "降噪后的干净发布", total: 2, added: 1, changed: 1, removed: 0, regime: "anchored", committedAt: new Date("2026-11-08T06:30:00Z"), sha: "5b18c75abc", url: "https://github.com/o/r/commit/5b18c75abc" })],
    });
    expect(markdown).toContain("其中 77 条来自 2026-11-08 措辞降噪上线前的全量重建口径");
  });

  it("omits the regime annotation when the window only has anchored releases", () => {
    const markdown = renderProgressSummary({ productName: "CoDelphi", days: 7, releases: [release()] });
    expect(markdown).not.toContain("口径注释");
  });
});
