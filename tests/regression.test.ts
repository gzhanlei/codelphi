import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRegressionStatuses, renderRegressionMarkdown, setRegressionItem, type RegressionStatusMap } from "../lib/regression";

const execute = vi.fn();

const changes = [
  { id: 101, releaseId: 7, kind: "changed" as const, entityType: "scenario" as const, featureName: "统一登录", scenarioReference: "HP-1", summary: "跳转页改为 /workspace", before: null, after: null },
  { id: 102, releaseId: 7, kind: "added" as const, entityType: "scenario" as const, featureName: "统一登录", scenarioReference: "HP-2", summary: "新增记住登录状态", before: null, after: null },
  { id: 103, releaseId: 7, kind: "removed" as const, entityType: "feature" as const, featureName: "架构图", scenarioReference: "", summary: "下线架构图生成", before: null, after: null },
];

const release = { id: 7, title: "v2026.11.07", summary: "s", sha: "abc1234def5678", url: "https://github.com/o/r/commit/abc", committedAt: new Date("2026-11-07T00:00:00Z"), specVersionId: 44 };

describe("regression item persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts a checked status scoped to the product's release and its spec version", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await setRegressionItem({ productId: 3, releaseId: 7, specChangeId: 101, status: "verified", checkedBy: "qa@example.com" }, execute);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO regression_items"),
      ["verified", "qa@example.com", 101, 7, 3],
    );
    expect(execute.mock.calls[0][0]).toContain("ON DUPLICATE KEY UPDATE");
  });

  it("rejects status changes for a change that does not belong to the release", async () => {
    execute.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(setRegressionItem({ productId: 3, releaseId: 7, specChangeId: 999, status: "verified", checkedBy: "qa@example.com" }, execute))
      .rejects.toThrow("regression_item_invalid");
  });

  it("loads statuses for every release of the product keyed by release and change", async () => {
    execute.mockResolvedValue([[
      { releaseId: 7, specChangeId: 101, status: "verified", checkedBy: "qa@example.com", checkedAt: new Date("2026-11-07T01:00:00Z") },
      { releaseId: 8, specChangeId: 102, status: "skipped", checkedBy: null, checkedAt: null },
    ]]);
    const statuses = await loadRegressionStatuses(3, execute);
    expect(statuses["7:101"]).toMatchObject({ status: "verified", checkedBy: "qa@example.com" });
    expect(statuses["8:102"]).toMatchObject({ status: "skipped" });
  });
});

describe("regression markdown export", () => {
  it("groups changes by feature with checkbox state from persisted statuses", () => {
    const statuses: RegressionStatusMap = { "7:101": { status: "verified", checkedBy: "qa@example.com" } };
    const markdown = renderRegressionMarkdown({ productName: "Radar", release, changes, statuses });
    expect(markdown).toContain("# 回归清单 · v2026.11.07");
    expect(markdown).toContain("https://github.com/o/r/commit/abc");
    expect(markdown).toContain("## 统一登录");
    expect(markdown).toContain("- [x] [变化] HP-1 — 跳转页改为 /workspace（已验证 @ qa@example.com）");
    expect(markdown).toContain("- [ ] [新增] HP-2 — 新增记住登录状态（待测）");
    expect(markdown).toContain("## 架构图");
    expect(markdown).toContain("- [ ] [移除] 下线架构图生成（待测）");
  });

  it("renders a slimmed-down regression suggestion when no behavior changes exist", () => {
    const markdown = renderRegressionMarkdown({ productName: "Radar", release, changes: [], statuses: {} });
    expect(markdown).toContain("未发现规格行为变化");
    expect(markdown).toContain("瘦身回归");
  });
});
