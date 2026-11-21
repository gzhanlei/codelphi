import { createHash } from "node:crypto";
import type { BehaviorExecutionTask } from "../behavior-inventory/types";
import type { BatchRegionAlias, BatchRequestStage } from "./types";

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * canonical 化：只对 object keys 递归排序；数组保持业务顺序（数组顺序即身份，
 * 见 §23.1 C1.1 与 identity 契约测试）。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** 指纹 = SHA-256(canonical JSON)；等价输入（object key 顺序不同）同指纹，数组重排不同指纹。 */
export function batchFingerprint(value: unknown): string {
  return sha256Utf8(canonicalJson(value));
}

export interface BatchIdentityInput {
  manifestHash: string;
  plannerVersion: string;
  orderedTaskKeys: readonly string[];
  groupingRulesFingerprint: string;
}

/**
 * batch_key = SHA-256(canonical{manifest_hash, planner_version, ordered_task_keys,
 * grouping_rules_fingerprint})（§23.1 C1.1）。planner version 是 plan 身份的一部分。
 */
export function makeBatchKey(input: BatchIdentityInput): string {
  return sha256Utf8(
    canonicalJson({
      kind: "analysis_behavior_batch_key",
      manifest_hash: input.manifestHash,
      planner_version: input.plannerVersion,
      ordered_task_keys: [...input.orderedTaskKeys],
      grouping_rules_fingerprint: input.groupingRulesFingerprint,
    }),
  );
}

/**
 * request_key 为全局唯一的明文复合键 `${batchAttemptUuid}|${stage}|${sequence}`
 * （§23.1 C1.1：可读可审计；SHA-256 只用于 batch_key/指纹，不用作 request_key 本体）。
 */
export function makeBatchRequestKey(input: {
  batchAttemptUuid: string;
  stage: BatchRequestStage;
  sequence: number;
}): string {
  return `${input.batchAttemptUuid}|${input.stage}|${input.sequence}`;
}

/**
 * R 别名按 manifest `anchorFragments` 原序生成（R1/R2/…），每项绑定真实 anchorFragmentKey
 * （§23.1 C1.2）：数组顺序即身份，不做稳定化排序；响应持久化后禁止重编号。
 */
export function makeOrderedRegionAliases(task: BehaviorExecutionTask): BatchRegionAlias[] {
  return task.anchorFragments.map((fragment, index) => ({
    anchorFragmentKey: fragment.anchorFragmentKey,
    regionAlias: `R${index + 1}`,
  }));
}
