import { describe, expect, it } from "vitest";
import { coverageByteLabel, coverageFilesLabel, coveragePercent } from "../lib/coverage-display";

const receipt = (ratio: number) => ({ coverageRatio: ratio, implFilesAssembled: 70, implFilesTotal: 79, implBytesAssembled: 1_000, implBytesTotal: 10_000, partitionsUsed: 3, partitionsCapped: false });

describe("coverage display (统一字节口径)", () => {
  it("formats the byte-based ratio with one decimal", () => {
    expect(coveragePercent(receipt(0.121))).toBe("12.1%");
    expect(coveragePercent(receipt(0.1))).toBe("10.0%");
    expect(coveragePercent(receipt(1))).toBe("100.0%");
    expect(coveragePercent(receipt(0))).toBe("0.0%");
  });

  it("names the byte basis explicitly and separates the file count as its own fact", () => {
    expect(coverageByteLabel(receipt(0.121))).toBe("源码装配覆盖率（按文件字节）12.1%");
    expect(coverageFilesLabel(receipt(0.121))).toBe("已装配实现文件 70/79 个");
  });

  it("never derives a percentage from file counts or renames the metric", () => {
    const label = coverageByteLabel(receipt(0.121));
    // 70/79 文件数 ≠ 88.6%，字节口径 12.1% 必须独立展示，不得混排成第二个百分比
    expect(label).not.toContain("88.6");
    expect(label).not.toContain("规格正确率");
    expect(label).not.toContain("证据可信度");
  });
});
