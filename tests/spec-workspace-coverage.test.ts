import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SpecWorkspace } from "../components/spec-workspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe("spec workspace coverage disclosure", () => {
  it("keeps factual coverage details without defending conclusion trust", () => {
    const html = renderToStaticMarkup(createElement(SpecWorkspace, {
      slug: "radar",
      productBase: "/products/default/radar",
      tree: [],
      scenarios: [],
      mode: "spec",
      coverage: {
        specVersionId: 8,
        coverageRatio: 0.421,
        implFilesAssembled: 12,
        implFilesTotal: 28,
        implBytesAssembled: 421,
        implBytesTotal: 1_000,
        partitionsUsed: 3,
        partitionsCapped: false,
      },
    }));

    expect(html).toContain("源码装配覆盖率（按文件字节）42.1%");
    expect(html).toContain("已装配实现文件 12/28 个");
    expect(html).toContain("3 趟提取");
    expect(html).toContain("运行时开关与数据依赖行为静态提取不可见");
    expect(html).not.toContain("低于 100% 是设计内行为");
    expect(html).not.toContain("不代表分析出错或结论不可信");
    expect(html).not.toContain("判断单条结论是否可信");
  });
});
