import { describe, expect, it, vi } from "vitest";
import { loadFeatureHistory } from "../lib/feature-history";

describe("feature history (CTO 复盘视图)", () => {
  it("groups spec_changes by release in descending time order", async () => {
    const execute = vi.fn(async () => [[
      { releaseId: 9, title: "新版本", sha: "bbb", url: "https://github.com/x/y/compare/b", committedAt: new Date("2026-11-10T00:00:00Z"), kind: "added", scenarioReference: "HP-2", summary: "URL 可点", highlightType: "News" },
      { releaseId: 9, title: "新版本", sha: "bbb", url: "https://github.com/x/y/compare/b", committedAt: new Date("2026-11-10T00:00:00Z"), kind: "changed", scenarioReference: "EC-1", summary: "重试分支", highlightType: null },
      { releaseId: 6, title: "旧版本", sha: "aaa", url: null, committedAt: new Date("2026-11-01T00:00:00Z"), kind: "removed", scenarioReference: "", summary: "移除旧入口", highlightType: null },
    ]]);
    const history = await loadFeatureHistory(execute as never, 1, "统一登录");
    expect(history).toHaveLength(2);
    expect(history[0].releaseId).toBe(9);
    expect(history[0].changes).toHaveLength(2);
    expect(history[1].changes[0].summary).toBe("移除旧入口");
    // 稳定键由功能名派生（spec_changes.feature_key）
    expect(execute).toHaveBeenCalledWith(expect.stringContaining("feature_key = ?"), [1, "统一登录"]);
  });

  it("returns an empty list when the feature has no behavior changes", async () => {
    const execute = vi.fn(async () => [[]]);
    expect(await loadFeatureHistory(execute as never, 1, "导出")).toEqual([]);
  });
});
