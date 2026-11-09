import { describe, expect, it } from "vitest";
import { buildDigest, type DigestChange } from "../lib/digest";

const change = (overrides: Partial<DigestChange> & { id: number }): DigestChange => ({
  releaseTitle: "v2026.11.09",
  releaseUrl: "https://github.com/o/r/commit/abc",
  kind: "changed",
  entityType: "scenario",
  featureName: "统一登录",
  scenarioReference: "HP-1",
  summary: "跳转页改为 /workspace",
  highlightType: null,
  evidencePaths: ["lib/auth.ts"],
  ...overrides,
});

describe("digest (A2)", () => {
  it("returns null when nothing changed in the period (无变化不发)", () => {
    expect(buildDigest({ periodStart: "2026-11-02", periodEnd: "2026-11-08", changes: [] })).toBeNull();
  });

  it("builds the three-audience sections from deterministic rules, every item anchored", () => {
    const digest = buildDigest({
      periodStart: "2026-11-02",
      periodEnd: "2026-11-08",
      changes: [
        change({ id: 101, highlightType: "Security", summary: "密码最短长度从 8 提到 12" }),
        change({ id: 102, highlightType: "Pricing", summary: "Pro 档价格调整为 $29" }),
        change({ id: 103, highlightType: "News", summary: "新增周报摘要页" }),
      ],
    })!;
    expect(digest.period).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    // 每条宣布项可回溯到 spec_changes id 与证据路径（§9 R1）
    expect(digest.changes.every((item) => typeof item.specChangeId === "number" && item.evidencePaths.length > 0)).toBe(true);
    // support / sales / marketing 各自意味着什么：确定性分桶
    expect(digest.audiences.support.some((item) => item.specChangeId === 101)).toBe(true);
    expect(digest.audiences.sales.some((item) => item.specChangeId === 102)).toBe(true);
    expect(digest.audiences.marketing.some((item) => item.specChangeId === 103)).toBe(true);
    // 关键变更在前（Highlight 九类固定顺序：Pricing 序位先于 Security，与 publishOrder 一致）
    expect(digest.changes[0].specChangeId).toBe(102);
  });

  it("keeps highlight-less changes in all three sections only when relevant (不夸大)", () => {
    const digest = buildDigest({
      periodStart: "2026-11-02", periodEnd: "2026-11-08",
      changes: [change({ id: 201, summary: "内部日志格式调整" })],
    })!;
    // 无 Highlight 的普通变更只进「本期变了什么」与 support（QA 视角），不进 sales/marketing
    expect(digest.changes).toHaveLength(1);
    expect(digest.audiences.sales).toHaveLength(0);
    expect(digest.audiences.marketing).toHaveLength(0);
    expect(digest.audiences.support).toHaveLength(1);
  });
});
