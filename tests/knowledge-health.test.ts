import { describe, expect, it } from "vitest";
import { buildKnowledgeHealth } from "../lib/knowledge-health";
import type { RegressionTaskView } from "../lib/regression-task-view";

const task = (overrides: Partial<RegressionTaskView> & { taskId: number; releaseId: number; status: RegressionTaskView["status"] }): RegressionTaskView =>
  ({
    primaryChangeId: null,
    featureName: "f",
    reference: "HP-1",
    subject: { kind: "scenario" as const, scenarioId: 1 },
    reasons: [],
    sources: [],
    checkedBy: null,
    skipReason: null,
    failureNote: null,
    ...overrides,
  }) as RegressionTaskView;

describe("knowledge health (P2 第一版：事实统计)", () => {
  const now = new Date("2026-11-11T00:00:00Z");

  const features = [
    { id: 1, name: "登录", staleSince: new Date("2026-11-01T00:00:00Z"), verifiedAt: new Date("2026-11-05T00:00:00Z"), lastEditedBy: "alice", lastEditedAt: new Date("2026-11-06T00:00:00Z") },
    { id: 2, name: "支付", staleSince: null, verifiedAt: null, lastEditedBy: "bob", lastEditedAt: new Date("2026-07-01T00:00:00Z") },
    { id: 3, name: "导出", staleSince: null, verifiedAt: null, lastEditedBy: null, lastEditedAt: null },
  ];
  const scenarios = [
    { id: 11, featureId: 1, reference: "HP-1", staleSince: null, verifiedAt: new Date("2026-11-05T00:00:00Z"), lastEditedBy: "alice", lastEditedAt: new Date("2026-11-06T00:00:00Z") },
    { id: 12, featureId: 1, reference: "EC-1", staleSince: new Date("2026-10-20T00:00:00Z"), verifiedAt: null, lastEditedBy: null, lastEditedAt: null },
  ];

  it("counts stale items, verification coverage, and regression four-state for the latest release only", () => {
    const report = buildKnowledgeHealth({
      features,
      scenarios,
      regressionTasks: [
        task({ taskId: 1, releaseId: 9, status: "passed" }),
        task({ taskId: 2, releaseId: 9, status: "failed" }),
        task({ taskId: 3, releaseId: 9, status: "pending" }),
        task({ taskId: 4, releaseId: 8, status: "passed" }),
      ],
      latestReleaseId: 9,
      now,
    });
    // 漂移按最久优先排序：EC-1（10-20）先于 登录（11-01）
    expect(report.staleCount).toBe(2);
    expect(report.staleItems[0]).toMatchObject({ reference: "EC-1", name: "登录" });
    expect(report.verifiedCount).toBe(2);
    expect(report.totalItems).toBe(5);
    expect(report.latestVerifiedAt).toBe("2026-11-05T00:00:00.000Z");
    expect(report.regression).toEqual({ total: 3, passed: 1, failed: 1, skipped: 0, pending: 1 });
  });

  it("aggregates maintenance attribution inside the window and discloses unattributed edits", () => {
    const report = buildKnowledgeHealth({ features, scenarios, regressionTasks: [], now, maintenanceWindowDays: 90 });
    // alice（11-06，窗口内 2 次）计入；bob（07-01，>90 天前）不计
    expect(report.maintenance).toEqual([{ editor: "alice", edits: 2 }]);
    expect(report.unattributedEdits).toBe(0);
  });

  it("counts edits without attribution as disclosed, never inferred", () => {
    const report = buildKnowledgeHealth({
      features: [{ ...features[2], lastEditedAt: new Date("2026-11-07T00:00:00Z") }],
      scenarios: [],
      regressionTasks: [],
      now,
    });
    expect(report.maintenance).toEqual([]);
    expect(report.unattributedEdits).toBe(1);
  });

  it("handles an empty product", () => {
    const report = buildKnowledgeHealth({ features: [], scenarios: [], regressionTasks: [], now });
    expect(report.totalItems).toBe(0);
    expect(report.staleCount).toBe(0);
    expect(report.latestVerifiedAt).toBeNull();
  });
});
