import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseCard } from "../components/release-card";
import type { RegressionTaskView } from "../lib/regression-tasks";
import type { BehaviorChangeRow, ChangeRow, ReleaseRow } from "../lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./demo-mode", () => ({ useDemoGuard: () => () => false }));
vi.mock("../components/demo-mode", () => ({ useDemoGuard: () => () => false }));

const release: ReleaseRow = { id: 7, title: "v2026.11.07", summary: "发布摘要", sha: "abc1234def5678", url: "https://github.com/o/r/commit/abc", committedAt: new Date("2026-11-07T00:00:00Z"), specVersionId: 44 };

const behaviorChanges: BehaviorChangeRow[] = [
  { id: 101, releaseId: 7, kind: "changed", entityType: "scenario", featureName: "统一登录", scenarioReference: "HP-1", summary: "跳转页改为 /workspace", before: null, after: null },
  { id: 102, releaseId: 7, kind: "added", entityType: "scenario", featureName: "统一登录", scenarioReference: "HP-2", summary: "新增记住登录状态", before: null, after: null },
];
const aiChanges: ChangeRow[] = [{ id: 201, releaseId: 7, featureName: "统一登录", kind: "changed", description: "登录跳转逻辑调整", userImpact: "", evidence: [] }];

function renderCard(overrides: { defaultOpen?: boolean; behaviorChanges?: BehaviorChangeRow[]; aiChanges?: ChangeRow[]; tasks?: RegressionTaskView[] } = {}) {
  return renderToStaticMarkup(createElement(ReleaseCard, {
    slug: "codelphi",
    release,
    changes: overrides.aiChanges ?? aiChanges,
    behaviorChanges: overrides.behaviorChanges ?? behaviorChanges,
    tasks: overrides.tasks ?? tasks,
    canEdit: false,
    defaultOpen: overrides.defaultOpen,
  }));
}

const tasks: RegressionTaskView[] = [
  { taskId: 9, releaseId: 7, subject: { kind: "scenario", scenarioId: 501 }, status: "pending", checkedBy: null, checkedAt: null, skipReason: null, failureNote: null, featureName: "统一登录", reference: "HP-1", primaryChangeId: 101, scenarioContext: null, scenarioAction: null, sources: [101], reasons: [{ hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 501 }] },
  { taskId: 10, releaseId: 7, subject: { kind: "scenario", scenarioId: 502 }, status: "pending", checkedBy: null, checkedAt: null, skipReason: null, failureNote: null, featureName: "统一登录", reference: "HP-2", primaryChangeId: 102, scenarioContext: null, scenarioAction: null, sources: [102], reasons: [{ hitType: "behavior_change", matchedPath: null, featureId: 11, scenarioId: 502 }] },
];

describe("release card collapse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the latest release expanded with a count summary", () => {
    const html = renderCard({ defaultOpen: true });
    expect(html).toContain("release-details");
    expect(html).toContain(' open');
    expect(html).toContain("行为变化 2 条");
    expect(html).toContain("发布说明 1 条");
  });

  it("renders older releases collapsed", () => {
    const html = renderCard({ defaultOpen: false });
    expect(html).toContain("release-details");
    expect(html).not.toContain(' open=""');
    expect(html).not.toContain("open");
    expect(html).toContain("行为变化 2 条");
  });

  it("keeps quiet releases as inline text without a toggle", () => {
    const html = renderCard({ behaviorChanges: [], aiChanges: [], tasks: [] });
    expect(html).not.toContain("release-details");
    expect(html).toContain("未发现规格行为变化");
    expect(html).toContain("瘦身回归");
  });

  it("lists wording-folded differences in a separate audit section", () => {
    const html = renderToStaticMarkup(createElement(ReleaseCard, {
      slug: "codelphi",
      release,
      changes: [],
      behaviorChanges,
      foldedChanges: [
        { id: -1, releaseId: 7, kind: "changed", entityType: "scenario", featureName: "统一登录", scenarioReference: "HP-3", summary: "场景表述仅措辞差异（行为等价，未计入行为变化）", before: null, after: null, reason: "wording" },
        { id: -2, releaseId: 8, kind: "changed", entityType: "scenario", featureName: "统一登录", scenarioReference: "HP-4", summary: "其他发布的折叠项", before: null, after: null, reason: "renumber" },
      ],
      tasks,
      canEdit: false,
    }));
    expect(html).toContain("另有 1 条差异判定为仅措辞/编号调整");
    expect(html).toContain("场景表述仅措辞差异（行为等价，未计入行为变化）");
    expect(html).not.toContain("其他发布的折叠项");
  });
});

describe("regression task rendering", () => {
  it("shows the marker for a non-pending task", () => {
    const html = renderCard({
      defaultOpen: true,
      tasks: [{ ...tasks[0], status: "passed", checkedBy: "pm@example.com" }],
    });
    expect(html).toContain("由 pm@example.com 标记");
  });

  it("shows reason tags and impact-only tasks without a change card", () => {
    const html = renderCard({
      defaultOpen: true,
      tasks: [
        { ...tasks[1], primaryChangeId: null, scenarioContext: null, scenarioAction: null, sources: [], reasons: [{ hitType: "evidence_path", matchedPath: "lib/token.ts", featureId: 11, scenarioId: 502 }] },
      ],
    });
    expect(html).toContain("影响面推荐");
    expect(html).toContain("证据路径命中");
    expect(html).toContain("lib/token.ts");
    expect(html).not.toContain("由 ");
  });
});
