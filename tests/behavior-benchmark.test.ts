import { describe, expect, it } from "vitest";
import {
  MAX_MACRO_EVIDENCE_SUPPORT_DROP,
  MAX_MACRO_FALSE_POSITIVE_RISE,
  MIN_PAIRED_BEHAVIOR_SAMPLES,
  NON_INFERIORITY_MARGIN,
  evaluateBehaviorNonInferiority,
  newcombePairedInterval,
  pairedRecallDelta,
  wilsonProportionInterval,
  type PairedBehaviorOutcome,
} from "../lib/behavior-benchmark";

/**
 * Task 15 · 配对行为 benchmark 统计层契约（设计 §9.5）：
 *  - 基本单位是冻结人工行为；召回差值 = inventory − legacy 的逐条配对二元结果均值；
 *  - 召回差值使用 Newcombe 配对差值 95% 区间（method 10：两条 Wilson 区间 square-and-add），
 *    禁止用两个独立 Wilson 区间代替差值检验；
 *  - 每条路径自身的召回/误报比例保留各自的 Wilson 区间（仅描述不确定性，不替代配对检验）；
 *  - 逐仓 LowerCI(Delta) 严格 > -0.03；区间跨过 -0.03（含 30 条初始下限仍功效不足）
 *    一律 inconclusive，区间整体低于 -0.03 为 inferior；
 *  - 误报分母 = 各路径实际评估的输出行为数（两路径分母独立，unmatched 输出不伪造配对）。
 *  期望值由独立参考实现（Wilson score + Newcombe 1998 method 10，z=1.959963984540054）离线计算。
 */

function pairs(n: number, inventoryHit: (index: number) => boolean, legacyHit: (index: number) => boolean): PairedBehaviorOutcome[] {
  const result: PairedBehaviorOutcome[] = [];
  for (let index = 1; index <= n; index += 1) {
    result.push({ behaviorId: `B${index}`, inventoryHit: inventoryHit(index), legacyHit: legacyHit(index) });
  }
  return result;
}

describe("pairedRecallDelta", () => {
  it("computes the mean of per-pair differences on the same frozen behaviors", () => {
    // inventory 命中 1..27，legacy 命中 1..29 → Delta = (27 − 29) / 30
    const sample = pairs(30, (i) => i <= 27, (i) => i <= 29);
    expect(pairedRecallDelta(sample)).toBeCloseTo(-2 / 30, 12);
  });

  it("is zero when both paths hit exactly the same behaviors", () => {
    expect(pairedRecallDelta(pairs(30, (i) => i <= 28, (i) => i <= 28))).toBe(0);
  });

  it("rejects empty pair sets (no defined recall delta)", () => {
    expect(() => pairedRecallDelta([])).toThrow(/empty|at least one/i);
  });
});

describe("wilsonProportionInterval (per-path own proportion)", () => {
  it("matches the reference Wilson score interval for 13/15 at 95%", () => {
    const interval = wilsonProportionInterval(13, 15);
    expect(interval.confidence).toBe(0.95);
    expect(interval.lower).toBeCloseTo(0.6211801716767764, 8);
    expect(interval.upper).toBeCloseTo(0.9626387408969346, 8);
  });

  it("handles boundary proportions without degenerating to a point", () => {
    expect(wilsonProportionInterval(0, 30).upper).toBeCloseTo(0.11351339317396876, 8);
    const full = wilsonProportionInterval(30, 30);
    expect(full.lower).toBeCloseTo(0.8864866068260312, 8);
    expect(full.upper).toBeCloseTo(1, 8);
  });

  it("rejects invalid counts", () => {
    expect(() => wilsonProportionInterval(31, 30)).toThrow();
    expect(() => wilsonProportionInterval(1, 0)).toThrow();
  });
});

describe("newcombePairedInterval", () => {
  it("matches the reference paired interval for fully discordant 28/28 at n=30", () => {
    // inventory 命中 1..28，legacy 命中 3..30（26 条共同命中 + 4 条不一致对）
    const interval = newcombePairedInterval(pairs(30, (i) => i <= 28, (i) => i >= 3));
    expect(interval.lower).toBeCloseTo(-0.1542867329432633, 8);
    expect(interval.upper).toBeCloseTo(0.1542867329432633, 8);
    expect(interval.confidence).toBe(0.95);
  });

  it("is not interchangeable with two independent Wilson intervals (gate verdict changes)", () => {
    // n=300，双方均命中前 294 条：配对区间 ±0.02536 整体高于 -0.03 → 非劣效可判；
    // 两个独立 Wilson 区间拼出的差值区间 ±0.03374 跨过 -0.03 → 同一批数据结论相反。
    const sample = pairs(300, (i) => i <= 294, (i) => i <= 294);
    const paired = newcombePairedInterval(sample);
    expect(paired.lower).toBeCloseTo(-0.025355815254697357, 8);
    expect(paired.upper).toBeCloseTo(0.025355815254697357, 8);
    expect(paired.lower).toBeGreaterThan(NON_INFERIORITY_MARGIN);
    // 独立 Wilson 的朴素差值区间 [l1−u2, u1−l2] 必须更宽并跨过阈值——不得用作替代
    const wilson = wilsonProportionInterval(294, 300);
    const naiveLower = wilson.lower - wilson.upper;
    const naiveUpper = wilson.upper - wilson.lower;
    expect(naiveLower).toBeCloseTo(-0.033741989260156924, 8);
    expect(naiveLower).toBeLessThan(NON_INFERIORITY_MARGIN);
    expect(paired.lower).toBeGreaterThan(naiveLower);
    expect(paired.upper).toBeLessThan(naiveUpper);
  });

  it("rejects empty pair sets", () => {
    expect(() => newcombePairedInterval([])).toThrow(/empty|at least one/i);
  });
});

describe("evaluateBehaviorNonInferiority", () => {
  it("passes a repo whose paired lower CI clears -0.03 strictly and reports both Wilson recalls", () => {
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/demo", pairs: pairs(300, (i) => i <= 294, (i) => i <= 294) },
    ]);
    expect(verdict.status).toBe("passed");
    const repo = verdict.repos[0];
    expect(repo.status).toBe("non_inferior");
    expect(repo.sampleSize).toBe(300);
    expect(repo.delta).toBe(0);
    expect(repo.deltaInterval?.lower).toBeCloseTo(-0.025355815254697357, 8);
    expect(repo.legacyRecall?.proportion).toBeCloseTo(0.98, 12);
    expect(repo.inventoryRecall?.interval.lower).toBeCloseTo(0.9570603791821394, 8);
    expect(repo.legacyRecall?.interval.lower).toBeCloseTo(0.9570603791821394, 8);
    expect(verdict.macroAverageDelta).toBe(0);
    expect(verdict.margin).toBe(-0.03);
    expect(verdict.minSamples).toBe(MIN_PAIRED_BEHAVIOR_SAMPLES);
  });

  it("applies the strict > -0.03 rule: a lower CI just below the margin is not non-inferior", () => {
    // n=300，inventory 292 命中 / legacy 294 命中：LowerCI = -0.03396，跨过 -0.03
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/demo", pairs: pairs(300, (i) => i <= 292, (i) => i <= 294) },
    ]);
    expect(verdict.repos[0].status).toBe("inconclusive");
    expect(verdict.repos[0].deltaInterval?.lower).toBeCloseTo(-0.03395785309186291, 8);
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.repos[0].reasons.join(" ")).toMatch(/-0\.03|margin/i);
  });

  it("treats 30 concordant pairs as underpowered, not as proof (inconclusive at the initial floor)", () => {
    // 30 条全部一致命中：LowerCI = -0.1135，区间跨过 -0.03 → 样本下限 ≠ 功效充分
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/demo", pairs: pairs(30, () => true, () => true) },
    ]);
    expect(verdict.repos[0].deltaInterval?.lower).toBeCloseTo(-0.1135133931739688, 8);
    expect(verdict.repos[0].status).toBe("inconclusive");
    expect(verdict.status).toBe("inconclusive");
  });

  it("marks repos below the 30-sample initial floor inconclusive without computing a verdict interval", () => {
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/demo", pairs: pairs(29, () => true, () => true) },
    ]);
    expect(verdict.repos[0].status).toBe("inconclusive");
    expect(verdict.repos[0].reasons.join(" ")).toMatch(/30/);
    expect(verdict.status).toBe("inconclusive");
  });

  it("fails a repo whose entire paired interval lies below the margin (inferior, not inconclusive)", () => {
    // n=300，inventory 270 / legacy 300：区间 [-0.1392, -0.0683] 整体低于 -0.03
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/demo", pairs: pairs(300, (i) => i <= 270, () => true) },
    ]);
    expect(verdict.repos[0].status).toBe("inferior");
    expect(verdict.repos[0].deltaInterval?.upper).toBeCloseTo(-0.06831611785523703, 8);
    expect(verdict.status).toBe("failed");
  });

  it("computes false-positive rates per path on its own evaluated-output denominator (no fake pairing)", () => {
    // legacy 评估 40 条输出（2 误报），inventory 评估 55 条输出（5 误报，含 15 条 unmatched）：
    // 分母各自独立（40 与 55），rise = 5/55 − 2/40 ≈ 0.0409 > 0.03 → 辅助门禁失败
    const verdict = evaluateBehaviorNonInferiority([
      {
        repo: "acme/demo",
        pairs: pairs(300, (i) => i <= 294, (i) => i <= 294),
        falsePositives: { legacy: { falsePositives: 2, evaluatedOutputs: 40 }, inventory: { falsePositives: 5, evaluatedOutputs: 55 } },
      },
    ]);
    const repo = verdict.repos[0];
    expect(repo.falsePositives?.legacy.proportion).toBeCloseTo(0.05, 12);
    expect(repo.falsePositives?.inventory.proportion).toBeCloseTo(5 / 55, 12);
    expect(repo.falsePositives?.legacy.interval.lower).toBeCloseTo(0.013820667386148344, 8);
    expect(repo.falsePositives?.inventory.interval.lower).toBeCloseTo(0.03945815507418035, 8);
    expect(verdict.macroFalsePositiveRise).toBeCloseTo(5 / 55 - 2 / 40, 12);
    expect(verdict.status).toBe("failed");
    expect(verdict.reasons.join(" ")).toMatch(/false.?positive/i);
  });

  it("gates macro evidence-support drop at 2 percentage points without touching the recall gate", () => {
    const verdict = evaluateBehaviorNonInferiority([
      {
        repo: "acme/demo",
        pairs: pairs(300, (i) => i <= 294, (i) => i <= 294),
        evidenceSupport: { legacy: { supported: 38, evaluatedOutputs: 40 }, inventory: { supported: 50, evaluatedOutputs: 55 } },
      },
    ]);
    expect(verdict.macroEvidenceSupportDrop).toBeCloseTo(38 / 40 - 50 / 55, 12);
    expect(verdict.macroEvidenceSupportDrop!).toBeGreaterThan(MAX_MACRO_EVIDENCE_SUPPORT_DROP);
    expect(verdict.status).toBe("failed");
    expect(verdict.reasons.join(" ")).toMatch(/evidence/i);
  });

  it("keeps the verdict passed when auxiliary gates stay within budget", () => {
    expect(MAX_MACRO_FALSE_POSITIVE_RISE).toBe(0.03);
    const verdict = evaluateBehaviorNonInferiority([
      {
        repo: "acme/demo",
        pairs: pairs(300, (i) => i <= 294, (i) => i <= 294),
        falsePositives: { legacy: { falsePositives: 2, evaluatedOutputs: 40 }, inventory: { falsePositives: 3, evaluatedOutputs: 55 } },
        evidenceSupport: { legacy: { supported: 38, evaluatedOutputs: 40 }, inventory: { supported: 52, evaluatedOutputs: 55 } },
      },
    ]);
    expect(verdict.status).toBe("passed");
  });

  it("averages deltas as a descriptive macro point estimate across repos", () => {
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/a", pairs: pairs(300, (i) => i <= 294, (i) => i <= 294) },
      { repo: "acme/b", pairs: pairs(300, (i) => i <= 293, (i) => i <= 294) },
    ]);
    expect(verdict.macroAverageDelta).toBeCloseTo((0 + -1 / 300) / 2, 12);
    expect(verdict.status).toBe("passed");
  });

  it("reports the macro average point estimate and fails when any repo is inferior", () => {
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/a", pairs: pairs(300, (i) => i <= 270, () => true) },
      { repo: "acme/b", pairs: pairs(300, (i) => i <= 294, (i) => i <= 294) },
    ]);
    expect(verdict.macroAverageDelta).toBeCloseTo((-0.1 + 0) / 2, 12);
    expect(verdict.status).toBe("failed");
  });

  it("is inconclusive when any repo is inconclusive and none is inferior", () => {
    const verdict = evaluateBehaviorNonInferiority([
      { repo: "acme/a", pairs: pairs(300, (i) => i <= 294, (i) => i <= 294) },
      { repo: "acme/b", pairs: pairs(12, () => true, () => true) },
    ]);
    expect(verdict.status).toBe("inconclusive");
  });

  it("rejects an empty comparison set", () => {
    const verdict = evaluateBehaviorNonInferiority([]);
    expect(verdict.status).toBe("inconclusive");
    expect(verdict.reasons.join(" ")).toMatch(/no repo|empty/i);
  });
});
