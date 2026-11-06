import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveAnalysisMode } from "../lib/incremental";
import { loadAffectedFeatureKeys } from "../lib/spec-file-index";

describe("resolveAnalysisMode", () => {
  const base = { mode: "incremental" as const, hasPreviousSpec: true, affectedCount: 2, previousFeatureCount: 10, diffFileCount: 30 };

  it("keeps incremental mode when the affected set is small and bounded", () => {
    expect(resolveAnalysisMode(base)).toBe("incremental");
  });

  it("falls back to full without a previous spec or with an empty affected set", () => {
    expect(resolveAnalysisMode({ ...base, hasPreviousSpec: false })).toBe("full");
    expect(resolveAnalysisMode({ ...base, affectedCount: 0 })).toBe("full");
  });

  it("falls back to full when the affected share exceeds the ratio or the diff is too wide", () => {
    expect(resolveAnalysisMode({ ...base, affectedCount: 7 })).toBe("full");
    expect(resolveAnalysisMode({ ...base, diffFileCount: 201 })).toBe("full");
  });

  it("passes full mode through untouched", () => {
    expect(resolveAnalysisMode({ ...base, mode: "full" })).toBe("full");
  });
});

describe("loadAffectedFeatureKeys", () => {
  it("joins the reverse index to stable keys and feature names for touched paths", async () => {
    const execute = vi.fn(async () => [[
      { stableKey: "登录", name: "登录" },
      { stableKey: "登录", name: "登录" },
      { stableKey: "支付", name: "支付" },
    ]]);
    const affected = await loadAffectedFeatureKeys(8, ["lib/auth.ts", "lib/pay.ts"], execute);
    expect(affected.keys).toEqual(new Set(["登录", "支付"]));
    expect(affected.names).toEqual(["登录", "支付"]);
    const [sql, parameters] = execute.mock.calls[0] as unknown[];
    expect(String(sql)).toContain("FROM spec_file_index i");
    expect(parameters).toEqual([8, "lib/auth.ts", "lib/pay.ts"]);
  });

  it("returns an empty set without touching the database when no paths are given", async () => {
    const execute = vi.fn();
    const affected = await loadAffectedFeatureKeys(8, [], execute);
    expect(affected.keys.size).toBe(0);
    expect(affected.names).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("analyze mode migration", () => {
  it("adds a per-product analyze mode defaulting to full", () => {
    const sql = readFileSync(new URL("../migrations/019_analyze_mode.sql", import.meta.url), "utf8");
    expect(sql).toContain("ADD COLUMN analyze_mode VARCHAR(16) NOT NULL DEFAULT 'full'");
  });
});
