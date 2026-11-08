import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import { markSpecDrift } from "../lib/spec-drift";

function connectionWith(routes: Record<string, unknown[]>) {
  const execute = vi.fn();
  const connection = { execute } as unknown as PoolConnection;
  execute.mockImplementation(async (sql: string) => {
    for (const [fragment, rows] of Object.entries(routes)) {
      if (sql.includes(fragment)) return [rows];
    }
    return [{}];
  });
  return { connection, execute };
}

const changes = [
  { id: 101, entityType: "feature", featureKey: "登录", scenarioReference: "" },
  { id: 102, entityType: "scenario", featureKey: "登录", scenarioReference: "EC-2" },
];

const features = [
  { id: 1, name: "登录", source: "manual" },
  { id: 2, name: "支付", source: "generated" },
];
const scenarios = [
  { id: 11, featureId: 1, reference: "EC-2", source: "manual" },
  { id: 12, featureId: 1, reference: "HP-1", source: "generated" },
];

describe("markSpecDrift", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks manual features and scenarios touched by this version's changes", async () => {
    const { connection, execute } = connectionWith({
      "FROM spec_changes": changes,
      "FROM features WHERE product_id": features,
      "JOIN features f": scenarios,
    });
    await markSpecDrift(connection, 7, 900);
    const calls = execute.mock.calls as Array<[string, unknown[]]>;
    const featureUpdate = calls.find(([sql]) => sql.includes("UPDATE features SET stale_since"));
    const scenarioUpdate = calls.find(([sql]) => sql.includes("UPDATE scenarios SET stale_since"));
    expect(featureUpdate?.[1]).toEqual([101, 1]);
    expect(scenarioUpdate?.[1]).toEqual([102, 11]);
  });

  it("does not stale a manual feature from scenario-level churn on generated scenarios", async () => {
    // 生产事故 2026-11-08：manual 功能「产品总览与产品页」的场景全为 generated，
    // AI 提取抖动（场景增删）反复打点人工条目，用户核实 6 次仍复现。
    // 打点粒度 = 变化粒度：scenario 级变化只打 manual 场景，不牵连 manual 功能。
    const { connection, execute } = connectionWith({
      "FROM spec_changes": [{ id: 104, entityType: "scenario", featureKey: "登录", scenarioReference: "HP-1" }],
      "FROM features WHERE product_id": features,
      "JOIN features f": scenarios,
    });
    await markSpecDrift(connection, 7, 900);
    const calls = execute.mock.calls as Array<[string, unknown[]]>;
    expect(calls.some(([sql]) => sql.includes("UPDATE features SET stale_since"))).toBe(false);
    // generated 场景 HP-1（id 12）也不打点
    const scenarioUpdate = calls.find(([sql]) => sql.includes("UPDATE scenarios SET stale_since"));
    expect(scenarioUpdate).toBeUndefined();
  });

  it("skips generated rows and unknown feature keys without writing", async () => {
    const { connection, execute } = connectionWith({
      "FROM spec_changes": [{ id: 103, entityType: "feature", featureKey: "不存在的功能", scenarioReference: "" }],
      "FROM features WHERE product_id": features,
      "JOIN features f": scenarios,
    });
    await markSpecDrift(connection, 7, 900);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("UPDATE features SET stale_since"))).toBe(false);
    expect(execute.mock.calls.some(([sql]) => String(sql).includes("UPDATE scenarios SET stale_since"))).toBe(false);
  });

  it("does nothing when the version has no changes", async () => {
    const { connection, execute } = connectionWith({ "FROM spec_changes": [] });
    await markSpecDrift(connection, 7, 900);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("spec drift migration", () => {
  it("adds stale provenance columns to features and scenarios", () => {
    const sql = readFileSync(new URL("../migrations/018_spec_drift.sql", import.meta.url), "utf8");
    expect(sql.match(/ALTER TABLE features/g)?.length).toBe(1);
    expect(sql.match(/ALTER TABLE scenarios/g)?.length).toBe(1);
    expect(sql).toContain("stale_since DATETIME(3) NULL");
    expect(sql).toContain("stale_change_id BIGINT UNSIGNED NULL");
  });
});
