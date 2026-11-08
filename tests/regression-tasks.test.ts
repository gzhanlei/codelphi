import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  planRegressionTasks,
  renderRegressionTaskMarkdown,
  setRegressionTask,
  loadRegressionTasks,
  type PlannedChange,
  type IndexHit,
  type RegressionTaskView,
} from "../lib/regression-tasks";

const execute = vi.fn();

const change = (overrides: Partial<PlannedChange> & Pick<PlannedChange, "id">): PlannedChange => ({
  entityType: "scenario",
  kind: "changed",
  featureId: 11,
  featureKey: "login",
  featureName: "统一登录",
  scenarioReference: "HP-1",
  scenarioId: 501,
  ...overrides,
});

const hit = (overrides: Partial<IndexHit> & Pick<IndexHit, "path">): IndexHit => ({
  featureId: 11,
  featureKey: "login",
  featureName: "统一登录",
  scenarioId: null,
  reference: null,
  ...overrides,
});

describe("planRegressionTasks", () => {
  it("anchors a changed scenario to the scenario with a behavior_change reason and its change as source", () => {
    const tasks = planRegressionTasks({ changes: [change({ id: 101 })], fileHits: [], featureScenarios: new Map() });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toEqual({ kind: "scenario", scenarioId: 501 });
    expect(tasks[0].sources).toEqual([101]);
    expect(tasks[0].reasons).toEqual([{ hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 }]);
  });

  it("anchors removed scenarios and feature-level changes to the change itself", () => {
    const tasks = planRegressionTasks({
      changes: [change({ id: 102, kind: "removed", scenarioId: null }), change({ id: 103, entityType: "feature", kind: "removed", scenarioReference: "", scenarioId: null })],
      fileHits: [],
      featureScenarios: new Map(),
    });
    expect(tasks.map((task) => task.subject)).toEqual([{ kind: "change", changeId: 102 }, { kind: "change", changeId: 103 }]);
    for (const task of tasks) {
      expect(task.sources).toEqual([task.subject.kind === "change" ? task.subject.changeId : null]);
      expect(task.reasons[0].hitType).toBe("behavior_change");
    }
  });

  it("merges an evidence-path hit on the same scenario into one task with two reasons", () => {
    const tasks = planRegressionTasks({
      changes: [change({ id: 101 })],
      fileHits: [hit({ path: "components/login.tsx", scenarioId: 501, reference: "HP-1" })],
      featureScenarios: new Map(),
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].sources).toEqual([101]);
    expect(tasks[0].reasons).toEqual([
      { hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 },
      { hitType: "evidence_path", matchedPath: "components/login.tsx", featureId: 11, scenarioId: 501 },
    ]);
  });

  it("recommends an untouched scenario purely from evidence-path hits, with no sources", () => {
    const tasks = planRegressionTasks({
      changes: [change({ id: 103, entityType: "feature", kind: "changed", scenarioReference: "", scenarioId: null })],
      fileHits: [hit({ path: "lib/token.ts", scenarioId: 502, reference: "HP-2" })],
      featureScenarios: new Map(),
    });
    expect(tasks).toHaveLength(2);
    const impacted = tasks.find((task) => task.subject.kind === "scenario" && task.subject.scenarioId === 502);
    expect(impacted?.sources).toEqual([]);
    expect(impacted?.reasons).toEqual([{ hitType: "evidence_path", matchedPath: "lib/token.ts", featureId: 11, scenarioId: 502 }]);
  });

  it("expands feature-wide hits to every scenario of the feature", () => {
    const tasks = planRegressionTasks({
      changes: [],
      fileHits: [hit({ path: "lib/login-shared.ts", scenarioId: null })],
      featureScenarios: new Map([[11, [{ scenarioId: 501, reference: "HP-1" }, { scenarioId: 502, reference: "HP-2" }]]]),
    });
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task.subject.kind).toBe("scenario");
      expect(task.reasons).toEqual([{ hitType: "feature_wide", matchedPath: "lib/login-shared.ts", featureId: 11, scenarioId: (task.subject as { scenarioId: number }).scenarioId }]);
    }
  });

  it("deduplicates reasons and scenario tasks across repeated hits", () => {
    const tasks = planRegressionTasks({
      changes: [],
      fileHits: [hit({ path: "lib/token.ts", scenarioId: 502, reference: "HP-2" }), hit({ path: "lib/token.ts", scenarioId: 502, reference: "HP-2" })],
      featureScenarios: new Map(),
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].reasons).toHaveLength(1);
  });

  it("keeps a deterministic order across planning runs", () => {
    const input = {
      changes: [change({ id: 101 }), change({ id: 102, scenarioId: 502, scenarioReference: "HP-2" })],
      fileHits: [hit({ path: "lib/token.ts", scenarioId: 503, reference: "ER-1", featureId: 12, featureKey: "billing", featureName: "账单" })],
      featureScenarios: new Map(),
    };
    const first = planRegressionTasks(input);
    const second = planRegressionTasks(input);
    expect(first.map((task) => task.subject)).toEqual(second.map((task) => task.subject));
  });
});

describe("regression task status persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts the four-state status with the checker identity", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await setRegressionTask({ productId: 3, taskId: 9, status: "passed", checkedBy: "qa@example.com" }, execute);
    const [statement, params] = execute.mock.calls[0];
    expect(statement).toContain("UPDATE regression_tasks");
    expect(statement).toContain("JOIN releases");
    expect(params).toContain("passed");
    expect(params).toContain("qa@example.com");
  });

  it("records a skip reason only for skipped tasks and a failure note only for failed ones", async () => {
    execute.mockResolvedValue([{ affectedRows: 1 }]);
    await setRegressionTask({ productId: 3, taskId: 9, status: "skipped", skipReason: "环境受限", checkedBy: "qa@example.com" }, execute);
    const [, skipParams] = execute.mock.calls[0];
    expect(skipParams).toContain("环境受限");
    expect(skipParams).not.toContain("缺陷备注");

    await setRegressionTask({ productId: 3, taskId: 9, status: "failed", failureNote: "BUG-12", checkedBy: "qa@example.com" }, execute);
    const [, failParams] = execute.mock.calls[1];
    expect(failParams).toContain("BUG-12");

    await setRegressionTask({ productId: 3, taskId: 9, status: "passed", checkedBy: "qa@example.com" }, execute);
    const [, passParams] = execute.mock.calls[2];
    expect(passParams).not.toContain("BUG-12");
  });

  it("rejects status changes for a task outside the product", async () => {
    execute.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(setRegressionTask({ productId: 3, taskId: 9, status: "passed", checkedBy: "qa@example.com" }, execute))
      .rejects.toThrow("regression_task_invalid");
  });
});

describe("loadRegressionTasks", () => {
  it("assembles tasks with subject, sources and reasons", async () => {
    execute.mockImplementation(async (statement: string) => {
      if (statement.includes("FROM regression_tasks")) {
        return [[
          { taskId: 9, releaseId: 7, status: "pending", checkedBy: null, checkedAt: null, skipReason: null, failureNote: null, specScenarioId: 501, specChangeId: null, featureName: "统一登录", reference: "HP-1", primaryChangeId: 101 },
        ]];
      }
      if (statement.includes("regression_task_sources")) return [[{ taskId: 9, changeId: 101 }]];
      if (statement.includes("regression_task_reasons")) return [[{ taskId: 9, hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 }]];
      return [[]];
    });
    const tasks = await loadRegressionTasks(3, execute);
    expect(tasks).toHaveLength(1);
    const task: RegressionTaskView = tasks[0];
    expect(task.subject).toEqual({ kind: "scenario", scenarioId: 501 });
    expect(task.featureName).toBe("统一登录");
    expect(task.primaryChangeId).toBe(101);
    expect(task.sources).toEqual([101]);
    expect(task.reasons).toHaveLength(1);
  });
});

describe("regression markdown export", () => {
  const release = { id: 7, title: "v2026.11.07", summary: "s", sha: "abc1234def5678", url: "https://github.com/o/r/commit/abc", committedAt: new Date("2026-11-07T00:00:00Z"), specVersionId: 44 };
  const changes = [
    { id: 101, releaseId: 7, kind: "changed" as const, entityType: "scenario" as const, featureName: "统一登录", scenarioReference: "HP-1", summary: "跳转页改为 /workspace", before: null, after: null },
  ];

  it("renders scenario tasks with reasons, merged sources and checker", () => {
    const tasks: RegressionTaskView[] = [{
      taskId: 9,
      releaseId: 7,
      subject: { kind: "scenario", scenarioId: 501 },
      status: "passed",
      checkedBy: "qa@example.com",
      checkedAt: null,
      skipReason: null,
      failureNote: null,
      featureName: "统一登录",
      reference: "HP-1",
      primaryChangeId: 101,
      scenarioContext: null, scenarioAction: null,
      sources: [101, 102],
      reasons: [
        { hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 },
        { hitType: "evidence_path", matchedPath: "components/login.tsx", featureId: 11, scenarioId: 501 },
      ],
    }];
    const markdown = renderRegressionTaskMarkdown({ productName: "Radar", release, changes, tasks });
    expect(markdown).toContain("# 回归清单 · v2026.11.07");
    expect(markdown).toContain("## 统一登录");
    expect(markdown).toContain("- [x] [变化] HP-1 — 跳转页改为 /workspace");
    expect(markdown).toContain("行为变化");
    expect(markdown).toContain("证据路径命中 components/login.tsx");
    expect(markdown).toContain("来自 2 条变化");
    expect(markdown).toContain("已通过 @ qa@example.com");
  });

  it("renders failure notes and skip reasons", () => {
    const tasks: RegressionTaskView[] = [
      { taskId: 9, releaseId: 7, subject: { kind: "change", changeId: 101 }, status: "failed", checkedBy: "qa@example.com", checkedAt: null, skipReason: null, failureNote: "BUG-12", featureName: "统一登录", reference: "HP-1", primaryChangeId: 101, scenarioContext: null, scenarioAction: null, sources: [101], reasons: [{ hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 }] },
      { taskId: 10, releaseId: 7, subject: { kind: "scenario", scenarioId: 502 }, status: "skipped", checkedBy: "qa@example.com", checkedAt: null, skipReason: "与本次改动无关", failureNote: null, featureName: "统一登录", reference: "HP-2", primaryChangeId: null, scenarioContext: null, scenarioAction: null, sources: [], reasons: [{ hitType: "feature_wide", matchedPath: "lib/login-shared.ts", featureId: 11, scenarioId: 502 }] },
    ];
    const markdown = renderRegressionTaskMarkdown({ productName: "Radar", release, changes, tasks });
    expect(markdown).toContain("未通过：BUG-12");
    expect(markdown).toContain("整功能受影响 lib/login-shared.ts");
    expect(markdown).toContain("已跳过：与本次改动无关");
  });

  it("renders impact-only tasks with the scenario context so QA knows what to test", () => {
    const tasks: RegressionTaskView[] = [{
      taskId: 11, releaseId: 7, subject: { kind: "scenario", scenarioId: 502 }, status: "pending", checkedBy: null, checkedAt: null,
      skipReason: null, failureNote: null, featureName: "统一登录", reference: "HP-2", primaryChangeId: null, sources: [],
      reasons: [{ hitType: "evidence_path", matchedPath: "lib/token.ts", featureId: 11, scenarioId: 502 }],
      scenarioContext: "用户在登录页勾选记住状态", scenarioAction: "关闭浏览器后重新访问",
    }];
    const markdown = renderRegressionTaskMarkdown({ productName: "Radar", release, changes, tasks });
    expect(markdown).toContain("HP-2 — 用户在登录页勾选记住状态 关闭浏览器后重新访问");
    expect(markdown).toContain("影响面推荐");
  });

  it("attaches the scenario behavior text so QA can verify without opening the spec page", () => {
    const withBehavior = [{ ...changes[0], after: { reference: "HP-1", context: "已登录用户点击同步", action: "触发手动同步", outcome: "返回最新进度并刷新状态", category: "happy" } }];
    const tasks: RegressionTaskView[] = [{
      taskId: 12, releaseId: 7, subject: { kind: "change", changeId: 101 }, status: "pending", checkedBy: null, checkedAt: null,
      skipReason: null, failureNote: null, featureName: "统一登录", reference: "HP-1", primaryChangeId: 101,
      scenarioContext: null, scenarioAction: null, sources: [101],
      reasons: [{ hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 }],
    }];
    const markdown = renderRegressionTaskMarkdown({ productName: "Radar", release, changes: withBehavior, tasks });
    expect(markdown).toContain("情境：已登录用户点击同步｜操作：触发手动同步｜结果：返回最新进度并刷新状态");
  });

  it("keeps the previous behavior text for removed scenarios", () => {
    const removed = [{ ...changes[0], kind: "removed" as const, before: { reference: "HP-1", context: "旧情境", action: "旧操作", outcome: "旧结果", category: "happy" }, after: null }];
    const tasks: RegressionTaskView[] = [{
      taskId: 13, releaseId: 7, subject: { kind: "change", changeId: 101 }, status: "pending", checkedBy: null, checkedAt: null,
      skipReason: null, failureNote: null, featureName: "统一登录", reference: "HP-1", primaryChangeId: 101,
      scenarioContext: null, scenarioAction: null, sources: [101],
      reasons: [{ hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 }],
    }];
    const markdown = renderRegressionTaskMarkdown({ productName: "Radar", release, changes: removed, tasks });
    expect(markdown).toContain("情境：旧情境｜操作：旧操作｜结果：旧结果");
  });

  it("renders a slimmed-down regression suggestion when no tasks exist", () => {
    const markdown = renderRegressionTaskMarkdown({ productName: "Radar", release, changes: [], tasks: [] });
    expect(markdown).toContain("未发现规格行为变化");
    expect(markdown).toContain("瘦身回归");
  });
});
