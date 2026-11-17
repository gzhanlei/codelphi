import { describe, expect, it } from "vitest";
import { buildDomainMergePrompt, parseDomainMerge } from "../lib/business-domain-candidates";
import type { DomainCandidate } from "../lib/business-domain-candidates";

// 分批生成后的全局合成（2026-11-17 codelphi 153 功能超单次规模）：AI 只分组子候选索引，
// featureIds 由程序拼接——ID 不经过 AI，防漂移。

const sub: DomainCandidate[] = [
  { name: "登录注册", summary: "a", featureIds: [1, 2], evidencePaths: [], unknowns: [], source: "generated" },
  { name: "MFA", summary: "b", featureIds: [3], evidencePaths: [], unknowns: [], source: "generated" },
  { name: "订单", summary: "c", featureIds: [4, 5], evidencePaths: [], unknowns: [], source: "generated" },
  { name: "退款", summary: "d", featureIds: [6], evidencePaths: [], unknowns: [], source: "generated" },
];

describe("parseDomainMerge", () => {
  it("merges sub-candidate indexes into final domains with program-assembled featureIds", () => {
    const content = JSON.stringify([
      { name: "身份认证", summary: "注册登录与二次验证", groups: [0, 1] },
      { name: "交易与售后", summary: "下单退款", groups: [2, 3] },
    ]);
    const result = parseDomainMerge(content, sub);
    expect(result.errors).toEqual([]);
    expect(result.domains).toEqual([
      { name: "身份认证", summary: "注册登录与二次验证", featureIds: [1, 2, 3] },
      { name: "交易与售后", summary: "下单退款", featureIds: [4, 5, 6] },
    ]);
  });

  it("keeps a sub-candidate unmerged as its own domain when left out of every group", () => {
    const content = JSON.stringify([{ name: "身份认证", summary: "", groups: [0, 1] }]);
    const result = parseDomainMerge(content, sub);
    expect(result.errors).toEqual([]);
    expect(result.domains.map((d) => d.name)).toEqual(["身份认证", "订单", "退款"]);
  });

  it("rejects out-of-range, duplicated or non-integer group indexes", () => {
    expect(parseDomainMerge(JSON.stringify([{ name: "A", summary: "", groups: [9] }]), sub).errors.length).toBeGreaterThan(0);
    expect(parseDomainMerge(JSON.stringify([{ name: "A", summary: "", groups: [0, 0] }]), sub).errors.length).toBeGreaterThan(0);
    expect(parseDomainMerge(JSON.stringify([{ name: "A", summary: "", groups: ["0"] }]), sub).errors.length).toBeGreaterThan(0);
  });

  it("rejects unparseable or empty output and duplicate domain names", () => {
    expect(parseDomainMerge("not json", sub).errors.length).toBeGreaterThan(0);
    expect(parseDomainMerge("[]", sub).errors.length).toBeGreaterThan(0);
    expect(parseDomainMerge(JSON.stringify([{ name: "A", summary: "", groups: [0] }, { name: "A", summary: "", groups: [1] }]), sub).errors.length).toBeGreaterThan(0);
  });

  it("builds a merge prompt that lists sub-candidates with indexes and member counts", () => {
    const messages = buildDomainMergePrompt("CoDelphi", sub);
    expect(JSON.stringify(messages)).toContain("[0] 登录注册（2 个功能）");
    expect(JSON.stringify(messages)).toContain("groups 只能引用给出的索引");
  });
});
