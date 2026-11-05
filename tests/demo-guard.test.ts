import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DemoModeProvider, useDemoGuard, demoIntercepted } from "../components/demo-mode";

describe("demoIntercepted", () => {
  it("shows the notice and intercepts in demo mode", () => {
    const showNotice = vi.fn();
    expect(demoIntercepted(true, showNotice)).toBe(true);
    expect(showNotice).toHaveBeenCalledTimes(1);
  });

  it("does not show the notice and lets the action through outside demo mode", () => {
    const showNotice = vi.fn();
    expect(demoIntercepted(false, showNotice)).toBe(false);
    expect(showNotice).not.toHaveBeenCalled();
  });
});

describe("useDemoGuard", () => {
  function Probe() {
    const guard = useDemoGuard();
    return createElement("div", null, `intercepted:${guard()}`);
  }

  it("does not intercept outside a DemoModeProvider", () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain("intercepted:false");
  });

  it("intercepts and shows the demo notice inside a DemoModeProvider", () => {
    const html = renderToStaticMarkup(createElement(DemoModeProvider, null, createElement(Probe)));
    expect(html).toContain("intercepted:true");
    expect(html).toContain("Demo 模式");
    expect(html).toContain("这是 Radar 的只读演示站点，编辑内容不会保存。");
  });
});
