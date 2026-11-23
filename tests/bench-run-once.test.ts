import { describe, expect, it } from "vitest";
import { resolveBenchRunConfig } from "../scripts/bench-run-once";

describe("resolveBenchRunConfig", () => {
  it("uses explicit scratch database and target revision", () => {
    const afterSha = "2659429e588da466fcb712ba096531343aa75d08";
    expect(resolveBenchRunConfig({ mode: "inventory", database: "codelphi_bench_i1", afterSha })).toEqual({
      mode: "inventory",
      database: "codelphi_bench_i1",
      afterSha,
    });
  });

  it("preserves the existing default mode and revision", () => {
    expect(resolveBenchRunConfig({ mode: "legacy", database: "codelphi_bench" })).toEqual({
      mode: "legacy",
      database: "codelphi_bench",
      afterSha: "e157baba2bb1ae58f719c43f3a453e5b28326f33",
    });
  });

  it("rejects a non-scratch database before creating a run", () => {
    expect(() => resolveBenchRunConfig({ mode: "inventory", database: "radar" })).toThrow(/scratch/);
  });
});
