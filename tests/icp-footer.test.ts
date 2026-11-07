import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IcpFooter } from "../components/icp-footer";

describe("ICP footer", () => {
  it("renders the filing number linked to MIIT", () => {
    const html = renderToStaticMarkup(createElement(IcpFooter));
    expect(html).toContain("粤ICP备2026111842号-5");
    expect(html).toContain('href="https://beian.miit.gov.cn/"');
    expect(html).toContain('target="_blank"');
  });
});
