import { describe, expect, it } from "vitest";
import { crossLanguageText, isNegatedNearToken, negationCountOf } from "../lib/text-script";

describe("text script helpers (bilingual equivalence gates)", () => {
  it("flags a pair as cross-language only when exactly one side contains CJK", () => {
    expect(crossLanguageText("不可以重试", "cannot retry")).toBe(true);
    expect(crossLanguageText("返回 404", "returns 404")).toBe(true);
    expect(crossLanguageText("演示访客", "demo 访客")).toBe(false);
    expect(crossLanguageText("cannot retry", "cannot retry again")).toBe(false);
    expect(crossLanguageText("", "returns 404")).toBe(false);
  });

  it("counts negations per script", () => {
    expect(negationCountOf("不可以重试，无响应")).toBe(2);
    expect(negationCountOf("User cannot retry and gets no response")).toBe(2);
    expect(negationCountOf("User can retry and gets a response")).toBe(0);
    expect(negationCountOf("demo 访客不可发布")).toBe(1);
  });

  it("detects negation near a token in both languages", () => {
    expect(isNegatedNearToken("连接创建成功，不再返回 422", "422")).toBe(true);
    expect(isNegatedNearToken("creation no longer returns 422 to the client", "422")).toBe(true);
    expect(isNegatedNearToken("the endpoint never returns 422 after retry", "422")).toBe(true);
    expect(isNegatedNearToken("creation returns 422 with error details", "422")).toBe(false);
    expect(isNegatedNearToken("重试失败，但不是返回 422", "422")).toBe(false);
    expect(isNegatedNearToken("返回 422 与重试说明", "422")).toBe(false);
  });
});
