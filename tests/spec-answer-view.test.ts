import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpecAnswerView, SpecAsk } from "../components/spec-ask";
import type { DecoratedSpecAnswer } from "../lib/spec-ask";

const matched: DecoratedSpecAnswer = {
  status: "matched",
  question: "上传文件最多几个？",
  terms: ["上传"],
  features: [{ id: 1, name: "文件上传", summary: "上传附件，限制数量与大小", stableKey: "文件上传" }],
  scenarios: [{
    id: 11, featureId: 1, featureName: "文件上传", featureStableKey: "文件上传", reference: "HP-1",
    context: "用户在上传框选择附件", action: "一次选择不超过 10 个文件", outcome: "系统接受并进入上传队列",
    evidence: [{ path: "src/upload.ts", startLine: 42, url: "https://github.com/acme/radar/blob/abc1234/src/upload.ts#L42" }],
  }],
  notice: "以下为规格原文摘录，非 AI 生成；点击条目可查看完整功能与代码证据。",
  specVersionId: 7,
};
const uncovered: DecoratedSpecAnswer = {
  status: "uncovered", question: "怎么配置 SSO？", terms: ["SSO"],
  features: [], scenarios: [],
  notice: "当前规格未覆盖此问题，未覆盖部分不产生结论。可换用更贴近功能名称的词，或前往规格页查看。",
  specVersionId: null,
};

describe("SpecAnswerView (B2.1 rendering)", () => {
  it("renders matched features, scenarios and the version note", () => {
    const html = renderToStaticMarkup(createElement(SpecAnswerView, { answer: matched, productBase: "/p/radar" }));
    expect(html).toContain("文件上传");
    expect(html).toContain("用户在上传框选择附件");
    expect(html).toContain("一次选择不超过 10 个文件");
    expect(html).toContain("系统接受并进入上传队列");
    expect(html).toContain("基于规格版本 #7");
    expect(html).toContain('href="/p/radar?view=spec&amp;feature=1"');
    expect(html).toContain('href="https://github.com/acme/radar/blob/abc1234/src/upload.ts#L42"');
  });

  it("renders the uncovered notice without result cards", () => {
    const html = renderToStaticMarkup(createElement(SpecAnswerView, { answer: uncovered, productBase: "/p/radar" }));
    expect(html).toContain("当前规格未覆盖此问题");
    expect(html).not.toContain("spec-search-hit");
  });
});

describe("SpecAsk (B2.1 input, server-renderable initial state)", () => {
  it("shows the query box and a disabled button before any answer", () => {
    const html = renderToStaticMarkup(createElement(SpecAsk, { slug: "radar", productBase: "/p/radar" }));
    expect(html).toContain('aria-label="向规格提问"');
    expect(html).toContain("查规格");
    expect(html).toContain("disabled");
  });
});
