import { describe, expect, it } from "vitest";
import type { CodeRange } from "../lib/behavior-inventory/types";
import {
  assertRangesWithin,
  rangeLineCount,
  subtractRanges,
  unionRanges,
} from "../lib/behavior-inventory/ranges";

/** Task 2 契约（2026-11-19 行为清单全量分析）：整数闭区间的并集、差集与子集校验。
 *  同一 path 内合并重叠与整数相邻区间，不同 path 之间不合并；
 *  差集输出按 (path, startLine, endLine) 稳定排序，行数不得用长度求和推导。 */

function range(path: string, startLine: number, endLine: number): CodeRange {
  return { path, startLine, endLine };
}

describe("unionRanges", () => {
  it("merges overlapping chains into one interval", () => {
    const merged = unionRanges([
      range("src/a.ts", 10, 30),
      range("src/a.ts", 20, 40),
      range("src/a.ts", 35, 50),
    ]);
    expect(merged).toEqual([range("src/a.ts", 10, 50)]);
    expect(rangeLineCount(merged)).toBe(41);
  });

  it("merges integer-adjacent intervals", () => {
    expect(
      unionRanges([range("src/a.ts", 1, 10), range("src/a.ts", 11, 20)]),
    ).toEqual([range("src/a.ts", 1, 20)]);
  });

  it("keeps ranges from different paths separate and sorts output deterministically", () => {
    expect(
      unionRanges([
        range("src/b.ts", 5, 8),
        range("src/a.ts", 1, 10),
        range("src/b.ts", 1, 4),
      ]),
    ).toEqual([range("src/a.ts", 1, 10), range("src/b.ts", 1, 8)]);
  });

  it("drops ranges fully contained in another", () => {
    expect(
      unionRanges([range("src/a.ts", 1, 100), range("src/a.ts", 20, 40)]),
    ).toEqual([range("src/a.ts", 1, 100)]);
  });

  it("rejects inverted, empty, non-positive, and non-integer ranges", () => {
    expect(() => unionRanges([range("src/a.ts", 30, 20)])).toThrow(/range/i);
    expect(() => unionRanges([range("src/a.ts", 0, 5)])).toThrow(/range/i);
    expect(() => unionRanges([range("src/a.ts", 1.5, 5)])).toThrow(/range/i);
  });

  it("returns an empty list for empty input", () => {
    expect(unionRanges([])).toEqual([]);
  });
});

describe("subtractRanges", () => {
  it("removes the covered middle of a primary range", () => {
    expect(
      subtractRanges([range("src/a.ts", 1, 100)], [range("src/a.ts", 20, 40)]),
    ).toEqual([range("src/a.ts", 1, 19), range("src/a.ts", 41, 100)]);
  });

  it("clips overlapping covered ranges at the boundaries", () => {
    expect(
      subtractRanges(
        [range("src/a.ts", 10, 30)],
        [range("src/a.ts", 1, 15), range("src/a.ts", 25, 50)],
      ),
    ).toEqual([range("src/a.ts", 16, 24)]);
  });

  it("returns nothing when the primary is fully covered", () => {
    expect(
      subtractRanges([range("src/a.ts", 1, 50)], [range("src/a.ts", 1, 100)]),
    ).toEqual([]);
  });

  it("only subtracts covered ranges from the same path and sorts the residual", () => {
    expect(
      subtractRanges(
        [range("src/b.ts", 10, 20), range("src/a.ts", 1, 100)],
        [range("src/a.ts", 40, 60), range("src/c.ts", 1, 999)],
      ),
    ).toEqual([
      range("src/a.ts", 1, 39),
      range("src/a.ts", 61, 100),
      range("src/b.ts", 10, 20),
    ]);
  });

  it("validates both inputs and never invents coverage from length arithmetic", () => {
    expect(() => subtractRanges([range("src/a.ts", 30, 20)], [])).toThrow(/range/i);
    expect(() => subtractRanges([], [range("src/a.ts", 30, 20)])).toThrow(/range/i);
  });
});

describe("rangeLineCount", () => {
  it("counts each line once across overlapping inputs", () => {
    expect(
      rangeLineCount([range("src/a.ts", 1, 10), range("src/a.ts", 10, 20)]),
    ).toBe(20);
  });

  it("sums independent paths", () => {
    expect(
      rangeLineCount([range("src/a.ts", 1, 5), range("src/b.ts", 1, 5)]),
    ).toBe(10);
  });
});

describe("assertRangesWithin", () => {
  it("accepts inner ranges fully contained in the outer set", () => {
    expect(() =>
      assertRangesWithin(
        [range("src/a.ts", 5, 10), range("src/a.ts", 20, 25)],
        [range("src/a.ts", 1, 15), range("src/a.ts", 20, 25)],
      ),
    ).not.toThrow();
  });

  it("accepts inner ranges whose union spans multiple outer ranges", () => {
    expect(() =>
      assertRangesWithin(
        [range("src/a.ts", 1, 20)],
        [range("src/a.ts", 1, 10), range("src/a.ts", 11, 20)],
      ),
    ).not.toThrow();
  });

  it("rejects anchors that extend beyond the outer boundary", () => {
    expect(() =>
      assertRangesWithin(
        [range("src/a.ts", 1, 30)],
        [range("src/a.ts", 1, 10), range("src/a.ts", 11, 20)],
      ),
    ).toThrow(/within/i);
  });

  it("rejects inner ranges whose path is missing from the outer set", () => {
    expect(() =>
      assertRangesWithin([range("src/b.ts", 1, 5)], [range("src/a.ts", 1, 100)]),
    ).toThrow(/within/i);
  });

  it("validates both inputs before comparing", () => {
    expect(() => assertRangesWithin([range("src/a.ts", 30, 20)], [])).toThrow(/range/i);
  });
});
