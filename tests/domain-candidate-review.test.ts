import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DomainCandidateReview } from "../components/domain-candidate-review";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ Link: (props: { href: string; children: React.ReactNode }) => createElement("a", { href: props.href }, props.children) }));

// 主动提示（2026-11-17）：新增未分组功能的提示必须常显——有数量时点名，为 0 时也说清楚，不因数据为空隐藏。
describe("DomainCandidateReview ungrouped hint", () => {
  it("highlights the count of new ungrouped features with an action lead", () => {
    const html = renderToStaticMarkup(createElement(DomainCandidateReview, { slug: "p", canEdit: true, ungroupedCount: 3 }));
    expect(html).toContain("3 个新功能");
    expect(html).toContain("不会自动归入");
    expect(html).toContain("生成业务分组候选");
  });

  it("still renders an explicit all-clear line when nothing is ungrouped (never hidden by empty data)", () => {
    const html = renderToStaticMarkup(createElement(DomainCandidateReview, { slug: "p", canEdit: true, ungroupedCount: 0 }));
    expect(html).toContain("没有待归组的新功能");
  });

  it("stays silent about ungrouped features when the product has no domain grouping yet", () => {
    const html = renderToStaticMarkup(createElement(DomainCandidateReview, { slug: "p", canEdit: true, ungroupedCount: null }));
    expect(html).not.toContain("新功能");
    expect(html).toContain("生成业务分组候选");
  });
});
