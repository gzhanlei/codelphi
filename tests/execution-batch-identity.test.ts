import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";
import {
  batchFingerprint,
  makeBatchKey,
  makeBatchRequestKey,
  makeOrderedRegionAliases,
  sha256Utf8,
} from "../lib/execution-batch/identity";

/** 冻结契约锚点：docs/superpowers/specs/2026-11-21-execution-batch-design.md §23.1/§23.2/§23.9。 */
describe("execution batch identity contract", () => {
  it("derives stable batch and request identities", () => {
    const base = {
      manifestHash: "manifest-hash-1",
      plannerVersion: "1",
      orderedTaskKeys: ["task|A", "task|B", "task|C"],
      groupingRulesFingerprint: "grouping-1",
    };
    // 相同规范输入（object key 顺序不同）必须得到相同 batch key
    const reordered = {
      groupingRulesFingerprint: "grouping-1",
      orderedTaskKeys: ["task|A", "task|B", "task|C"],
      plannerVersion: "1",
      manifestHash: "manifest-hash-1",
    };
    expect(makeBatchKey(base)).toBe(makeBatchKey(reordered));
    // 数组业务顺序进入身份：重排 task keys 必须改变 batch key
    expect(makeBatchKey({ ...base, orderedTaskKeys: ["task|C", "task|B", "task|A"] })).not.toBe(makeBatchKey(base));
    // planner version 是 plan 身份的一部分
    expect(makeBatchKey({ ...base, plannerVersion: "2" })).not.toBe(makeBatchKey(base));

    // request key = 明文复合键 `${batchAttemptUuid}|${stage}|${sequence}`
    const requestInput = { batchAttemptUuid: "attempt-1", stage: "describe" as const, sequence: 1 };
    expect(makeBatchRequestKey(requestInput)).toBe("attempt-1|describe|1");
    expect(makeBatchRequestKey({ ...requestInput, stage: "judge" })).not.toBe(makeBatchRequestKey(requestInput));
    expect(makeBatchRequestKey({ ...requestInput, sequence: 2 })).not.toBe(makeBatchRequestKey(requestInput));

    // fingerprint 对 object key 顺序 canonical，对数组顺序敏感
    expect(batchFingerprint({ a: 1, b: [1, 2] })).toBe(batchFingerprint({ b: [1, 2], a: 1 }));
    expect(batchFingerprint([1, 2])).not.toBe(batchFingerprint([2, 1]));
    // sha256Utf8 输出 64 位小写十六进制
    expect(sha256Utf8("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists every anchor fragment in R order", () => {
    const aliases = makeOrderedRegionAliases(fragmentTask(["fragment|A", "fragment|B", "fragment|C"]));
    expect(aliases).toEqual([
      { anchorFragmentKey: "fragment|A", regionAlias: "R1" },
      { anchorFragmentKey: "fragment|B", regionAlias: "R2" },
      { anchorFragmentKey: "fragment|C", regionAlias: "R3" },
    ]);
    // 输入对象字段顺序不影响别名（canonicalization 只排 object keys）
    const shuffled: BehaviorExecutionTask = {
      ...fragmentTask(["fragment|A", "fragment|B", "fragment|C"]),
      anchorFragments: [
        { ranges: [], anchorFragmentKey: "fragment|A", anchorKey: "anchor|fragment|A" },
        { ranges: [], anchorKey: "anchor|fragment|B", anchorFragmentKey: "fragment|B" },
        { anchorFragmentKey: "fragment|C", ranges: [], anchorKey: "anchor|fragment|C" },
      ],
    };
    expect(makeOrderedRegionAliases(shuffled)).toEqual(aliases);
    // 数组顺序即身份：反转 fragments 后 R 别名跟随新顺序，不做稳定化排序
    expect(makeOrderedRegionAliases(fragmentTask(["fragment|C", "fragment|B", "fragment|A"]))).toEqual([
      { anchorFragmentKey: "fragment|C", regionAlias: "R1" },
      { anchorFragmentKey: "fragment|B", regionAlias: "R2" },
      { anchorFragmentKey: "fragment|A", regionAlias: "R3" },
    ]);
  });

  it("migration contains plan attempt member request and receipt identity tables", () => {
    const sql = readFileSync(new URL("../migrations/081_execution_batch.sql", import.meta.url), "utf8");
    for (const table of [
      "analysis_behavior_batch_plan_sets",
      "analysis_behavior_batch_plans",
      "analysis_behavior_batch_attempts",
      "analysis_behavior_batch_attempt_members",
      "analysis_behavior_batch_requests",
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    // plan set 两阶段发布：building → ready
    expect(sql).toContain("building");
    expect(sql).toContain("ready");
    // receipts 增可空 request_key/request_fingerprint/duration_ms，request_key 全局唯一
    expect(sql).toContain("ALTER TABLE llm_call_receipts ADD COLUMN request_key");
    expect(sql).toContain("ALTER TABLE llm_call_receipts ADD COLUMN request_fingerprint");
    expect(sql).toContain("ALTER TABLE llm_call_receipts ADD COLUMN duration_ms");
    expect(sql).toMatch(/UNIQUE KEY \w*request_key\w* \(request_key\)/);
    // 原始响应使用 MEDIUMTEXT；failed 行必填 failure_class
    expect(sql).toContain("MEDIUMTEXT");
    expect(sql).toContain("failure_class");
    // §23.9：plan 表不重复保存 plan set 级字段
    const plansBlock = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS analysis_behavior_batch_plans"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS analysis_behavior_batch_attempts"),
    );
    expect(plansBlock).not.toContain("plan_set_fingerprint");
    expect(plansBlock).not.toContain("fallback_assignments");
    // fallback 路由是真源字段，保存在 plan set 表
    const planSetsBlock = sql.slice(
      sql.indexOf("CREATE TABLE IF NOT EXISTS analysis_behavior_batch_plan_sets"),
      sql.indexOf("CREATE TABLE IF NOT EXISTS analysis_behavior_batch_plans"),
    );
    expect(planSetsBlock).toContain("fallback_assignments");
  });

  it("migration uses mysql compatible ddl", () => {
    const sql = readFileSync(new URL("../migrations/081_execution_batch.sql", import.meta.url), "utf8");
    const withoutComments = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(withoutComments).not.toMatch(/jsonb/i);
    expect(withoutComments).not.toMatch(/\bSERIAL\b/i);
    expect(withoutComments).not.toMatch(/\bRETURNING\b/i);
    // 纯增量迁移：不允许改写历史行（行首 UPDATE 语句；ON UPDATE CURRENT_TIMESTAMP 不受影响）
    expect(withoutComments).not.toMatch(/^\s*UPDATE\b/m);
  });
});

function fragmentTask(anchorFragmentKeys: readonly string[]): BehaviorExecutionTask {
  return {
    taskKey: "task|demo",
    unitKey: "unit|demo",
    anchorFragments: anchorFragmentKeys.map((anchorFragmentKey) => ({
      anchorKey: `anchor|${anchorFragmentKey}`,
      anchorFragmentKey,
      ranges: [],
    })),
  };
}
