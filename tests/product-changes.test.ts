import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProductChanges } from "../components/product-changes";
import type { BehaviorChangeRow, ChangeRow, FoldedBehaviorChangeRow, ReleaseRow } from "../lib/types";
import type { RegressionTaskView } from "../lib/regression-task-view";

const { releaseCard } = vi.hoisted(() => ({ releaseCard: vi.fn((_props: Record<string, unknown>) => null) }));
vi.mock("../components/release-card", () => ({ ReleaseCard: releaseCard }));

const releases: ReleaseRow[] = [
  { id: 7, title: "v7", summary: "七", sha: "abc1234", url: "https://github.com/o/r/commit/abc1234", committedAt: new Date("2026-11-07T00:00:00Z"), specVersionId: 44 },
  { id: 8, title: "v8", summary: "八", sha: "def5678", url: "https://github.com/o/r/commit/def5678", committedAt: new Date("2026-11-08T00:00:00Z"), specVersionId: 45 },
];
const behaviorChanges: BehaviorChangeRow[] = [
  { id: 101, releaseId: 7, kind: "changed", entityType: "scenario", featureName: "登录", scenarioReference: "HP-1", summary: "七", before: null, after: null },
  { id: 102, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "登录", scenarioReference: "HP-2", summary: "八", before: null, after: null },
];
const changes: ChangeRow[] = [
  { id: 201, releaseId: 7, featureName: "登录", kind: "changed", description: "七", userImpact: "", evidence: [] },
  { id: 202, releaseId: 8, featureName: "登录", kind: "changed", description: "八", userImpact: "", evidence: [] },
];
const foldedChanges: FoldedBehaviorChangeRow[] = [
  { ...behaviorChanges[0], id: -1, reason: "wording" },
  { ...behaviorChanges[1], id: -2, reason: "wording" },
];
const regressionTasks: RegressionTaskView[] = [
  { taskId: 301, releaseId: 7, subject: { kind: "scenario", scenarioId: 501 }, status: "pending", checkedBy: null, checkedAt: null, skipReason: null, failureNote: null, featureName: "登录", reference: "HP-1", primaryChangeId: 101, scenarioContext: null, scenarioAction: null, sources: [101], reasons: [] },
  { taskId: 302, releaseId: 8, subject: { kind: "scenario", scenarioId: 502 }, status: "pending", checkedBy: null, checkedAt: null, skipReason: null, failureNote: null, featureName: "登录", reference: "HP-2", primaryChangeId: 102, scenarioContext: null, scenarioAction: null, sources: [102], reasons: [] },
];

describe("product changes data partitioning", () => {
  beforeEach(() => releaseCard.mockClear());

  it("passes only each release's own data to its card", () => {
    renderToStaticMarkup(createElement(ProductChanges, {
      slug: "codelphi",
      releases,
      changes,
      reviewedChanges: changes,
      behaviorChanges,
      foldedChanges,
      regressionTasks,
      releaseTotal: 2,
    }));

    expect(releaseCard).toHaveBeenCalledTimes(2);
    const first = releaseCard.mock.calls[0][0];
    const second = releaseCard.mock.calls[1][0];
    expect((first.behaviorChanges as BehaviorChangeRow[]).map((change) => change.id)).toEqual([101]);
    expect((second.behaviorChanges as BehaviorChangeRow[]).map((change) => change.id)).toEqual([102]);
    expect((first.changes as ChangeRow[]).map((change) => change.id)).toEqual([201]);
    expect((second.changes as ChangeRow[]).map((change) => change.id)).toEqual([202]);
    expect((first.reviewedChanges as ChangeRow[]).map((change) => change.id)).toEqual([201]);
    expect((second.reviewedChanges as ChangeRow[]).map((change) => change.id)).toEqual([202]);
    expect((first.foldedChanges as FoldedBehaviorChangeRow[]).map((change) => change.id)).toEqual([-1]);
    expect((second.foldedChanges as FoldedBehaviorChangeRow[]).map((change) => change.id)).toEqual([-2]);
    expect((first.tasks as RegressionTaskView[]).map((task) => task.taskId)).toEqual([301]);
    expect((second.tasks as RegressionTaskView[]).map((task) => task.taskId)).toEqual([302]);
  });
});
