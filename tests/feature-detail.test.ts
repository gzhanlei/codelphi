import { describe, expect, it } from "vitest";
import { FEATURE_DETAIL } from "../lib/ui-strings/product";

// Task 2 证据措辞：实现文件聚合一律是「已发现证据」，不得暗示完整实现或测试已执行。
describe("feature detail evidence wording", () => {
  it("labels implementation files as discovered evidence, not proof of implementation", () => {
    expect(FEATURE_DETAIL.implementationFiles["zh-CN"]).toContain("已发现证据");
    expect(FEATURE_DETAIL.implementationFiles["zh-CN"]).toContain("不代表完整实现");
    expect(FEATURE_DETAIL.implementationFiles["zh-CN"]).not.toContain("实现分布");
    expect(FEATURE_DETAIL.implementationFiles.en).toMatch(/Evidence found/i);
    expect(FEATURE_DETAIL.implementationFiles.en).not.toMatch(/Implementation spread/i);
    // {count} 占位保留
    expect(FEATURE_DETAIL.implementationFiles["zh-CN"]).toContain("{count}");
  });
});
