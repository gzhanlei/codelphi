import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReleaseCard } from "../components/release-card";
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

function renderCard(overrides: { defaultOpen?: boolean; behaviorChanges?: BehaviorChangeRow[]; aiChanges?: ChangeRow[] } = {}) {
  return renderToStaticMarkup(createElement(ReleaseCard, {
    slug: "codelphi",
    release,
    changes: overrides.aiChanges ?? aiChanges,
    behaviorChanges: overrides.behaviorChanges ?? behaviorChanges,
    statuses: {},
    canEdit: false,
    defaultOpen: overrides.defaultOpen,
  }));
}

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
    const html = renderCard({ behaviorChanges: [], aiChanges: [] });
    expect(html).not.toContain("release-details");
    expect(html).toContain("未发现规格行为变化");
    expect(html).toContain("瘦身回归");
  });
});
