import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { evidenceKind } from "../lib/evidence";
import { EvidenceLinks } from "../components/evidence-links";

describe("evidenceKind", () => {
  it("classifies test files", () => {
    expect(evidenceKind("tests/release-card.test.ts")).toBe("test");
    expect(evidenceKind("lib/foo.spec.ts")).toBe("test");
  });

  it("classifies documentation and prompt declarations", () => {
    expect(evidenceKind("README.md")).toBe("document");
    expect(evidenceKind("docs/plan.md")).toBe("document");
  });

  it("treats everything else as implementation code", () => {
    expect(evidenceKind("components/release-card.tsx")).toBe("implementation");
    expect(evidenceKind("app/api/products/[slug]/route.ts")).toBe("implementation");
    expect(evidenceKind("lib/ai.ts")).toBe("implementation");
  });
});

describe("EvidenceLinks", () => {
  const value = [
    { path: "components/release-card.tsx", startLine: 116, url: "https://github.com/o/r/blob/abc/components/release-card.tsx#L116" },
    { path: "tests/release-card.test.ts", startLine: 50, url: "https://github.com/o/r/blob/abc/tests/release-card.test.ts#L50" },
    { path: "README.md", url: "https://github.com/o/r/blob/abc/README.md" },
  ];

  it("marks test and document evidence with their weaker strength, leaving implementation unmarked", () => {
    const html = renderToStaticMarkup(createElement(EvidenceLinks, { value }));
    expect(html).toContain("[测试]");
    expect(html).toContain("[文档]");
    expect(html).not.toContain("[实现]");
  });
});
