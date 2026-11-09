import { describe, expect, it } from "vitest";
import { buildDraftBlocks, validateDraft, canPublish, publishOrder, type ReleaseNoteChange } from "../lib/release-notes";

const change = (overrides: Partial<ReleaseNoteChange> & { id: number }): ReleaseNoteChange => ({
  kind: "changed",
  entityType: "scenario",
  featureName: "统一登录",
  scenarioReference: "HP-1",
  summary: "跳转页改为 /workspace",
  highlightType: null,
  evidencePaths: ["lib/auth.ts"],
  ...overrides,
});

describe("release notes (A2)", () => {
  it("builds blocks anchored to spec_change ids with evidence paths carried over", () => {
    const blocks = buildDraftBlocks([change({ id: 101 }), change({ id: 102 })]);
    expect(blocks.map((block) => block.specChangeId)).toEqual([101, 102]);
    expect(blocks[0].evidencePaths).toEqual(["lib/auth.ts"]);
  });

  it("orders selected changes by highlight before anything else (Highlights first, not auto-select-all)", () => {
    const changes = [
      change({ id: 1, highlightType: null }),
      change({ id: 2, highlightType: "Security" }),
      change({ id: 3, highlightType: "News" }),
      change({ id: 4, highlightType: "Pricing" }),
    ];
    // 九类固定顺序：Pricing（序位 2）先于 Security（序位 5）
    expect(publishOrder(changes).map((item) => item.id)).toEqual([4, 2, 3, 1]);
    // 不自动全选：只构建调用方勾选的块，顺序同样按 Highlight 排序
    expect(buildDraftBlocks(changes, [2, 4]).map((block) => block.specChangeId)).toEqual([4, 2]);
  });

  it("fails validation when a block references a nonexistent spec_change (引用存在性校验)", () => {
    const blocks = buildDraftBlocks([change({ id: 101 })]);
    const result = validateDraft(blocks, [change({ id: 999 })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("101");
  });

  it("fails validation when evidence is missing from the anchored change (越界证据路径)", () => {
    const blocks = buildDraftBlocks([change({ id: 101, evidencePaths: ["lib/auth.ts", "lib/vault.ts"] })]);
    // anchored change 的证据里没有 lib/secret.ts → 该块不允许存在
    const tampered = blocks.map((block, index) => (index === 0 ? { ...block, evidencePaths: [...block.evidencePaths, "lib/secret.ts"] } : block));
    const result = validateDraft(tampered, [change({ id: 101, evidencePaths: ["lib/auth.ts", "lib/vault.ts"] })]);
    expect(result.ok).toBe(false);
  });

  it("rejects an empty draft and rejects publishing an unvalidated draft (人工发布门禁)", () => {
    expect(canPublish([], new Set([1]))).toContain("empty");
    // 没有 spec_change 锚点的块集不能发布
    expect(canPublish([{ specChangeId: 404, evidencePaths: [] } as never], new Set())).toContain("anchor");
  });

  it("passes validation for well-anchored blocks", () => {
    const blocks = buildDraftBlocks([change({ id: 101 })]);
    expect(validateDraft(blocks, [change({ id: 101 })]).ok).toBe(true);
  });
});
