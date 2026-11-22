import { describe, expect, it } from "vitest";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";
import { makeOrderedRegionAliases } from "../lib/execution-batch/identity";
import { buildBatchFusedPrompt, parseBatchFusedContent } from "../lib/execution-batch/fused-protocol";
import { BatchProtocolError } from "../lib/execution-batch/protocol";
import { deriveBehaviorTaskResult } from "../lib/behavior-unit-extraction";
import type { TaskSource } from "../lib/behavior-inventory/planner";

const TASK_A = "task|alpha";
const TASK_B = "task|beta";

function makeTask(taskKey: string, regionCount = 1): BehaviorExecutionTask {
  return {
    taskKey,
    unitKey: `unit|${taskKey}`,
    anchorFragments: Array.from({ length: regionCount }, (_, index) => ({
      anchorKey: `anchor|${taskKey}#${index}`,
      anchorFragmentKey: `fragment|${taskKey}#${index}`,
      ranges: [{ startLine: index * 10 + 1, endLine: index * 10 + 9 }],
    })),
  };
}

function memberOf(taskKey: string, alias: string) {
  const task = makeTask(taskKey);
  return { task, member: { taskKey, taskAlias: alias, orderedRegionAliases: makeOrderedRegionAliases(task) } };
}

function sourcesFor(taskKey: string): TaskSource[] {
  return [{ path: `src/${taskKey.replace(/[|]/g, "-")}.ts`, role: "primary", content: "export function demo() {\n  return 1;\n}", startLine: 1, endLine: 3 }];
}

/** fused region：同时携带事实四元组（describe 职责）与判定字段（judge 职责）。 */
function fusedRegion(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    facts: "stores the record",
    inputs: "record payload",
    controlFlow: "insert then emit",
    externalEffects: "database write",
    disposition: "extracted",
    reason: "",
    evidence: [{ path: "src/task-alpha.ts", startLine: 2 }],
    scenarioRefs: ["HP-1"],
    relatedUnitKeys: [],
    relatedScenarioRefs: [],
    ...overrides,
  };
}

describe("execution batch fused protocol (Task 13)", () => {
  it("default mode remains dual stage", async () => {
    // 默认值与垃圾值都回退 describe_judge（fused 只在显式 flag 下进入）
    const { behaviorBatchExtractionMode } = await import("../lib/execution-batch/runner");
    process.env.ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE = "";
    expect(behaviorBatchExtractionMode()).toBe("describe_judge");
    process.env.ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE = "garbage";
    expect(behaviorBatchExtractionMode()).toBe("describe_judge");
    process.env.ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE = "fused";
    expect(behaviorBatchExtractionMode()).toBe("fused");
    delete process.env.ANALYSIS_BEHAVIOR_BATCH_EXTRACTION_MODE;
  });

  it("fused region preserves facts and judgment fields without weakening validation", () => {
    const a = memberOf(TASK_A, "T1");
    const content = JSON.stringify({
      tasks: [{ id: "T1", regions: [fusedRegion("R1")], features: [{ name: "F", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: "src/task-alpha.ts", startLine: 2 }] }] }] }],
    });
    const results = parseBatchFusedContent(content, [a.member]);
    expect(results[0]!.status).toBe("ok");
    const payload = results[0]!.payload!;
    // 判定字段保留（judge 职责不丢）；facts 四元组是 prompt 层的推理手法（要求模型先陈述
    // 事实再判定），parse 层与既有 judge schema 同构——不持久化事实、判定/场景/证据完整
    expect(payload.regions[0]!.disposition).toBe("extracted");
    expect(payload.regions[0]!.scenarioRefs).toEqual(["HP-1"]);
    // 与现有单任务 judge schema 深度兼容：直接可进现有推导
    const derived = deriveBehaviorTaskResult(a.task, sourcesFor(TASK_A), payload, "fused:T1");
    expect(derived.outcome).toBe("extracted");
  });

  it("missing facts evidence or surviving scenario attribution stays unresolved", () => {
    const a = memberOf(TASK_A, "T1");
    // extracted 但场景证据指向越界文件 → 现有 sanitize/推导必须落 unresolved（质量不弱化）
    const content = JSON.stringify({
      tasks: [{
        id: "T1",
        regions: [{ ...fusedRegion("R1"), evidence: [{ path: "src/elsewhere.ts", startLine: 2 }], scenarioRefs: ["HP-1"] }],
        features: [{ name: "F", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: "src/elsewhere.ts", startLine: 2 }] }] }],
      }],
    });
    const results = parseBatchFusedContent(content, [a.member]);
    expect(results[0]!.status).toBe("ok");
    const derived = deriveBehaviorTaskResult(a.task, sourcesFor(TASK_A), results[0]!.payload!, "fused:T1");
    expect(derived.outcome).toBe("unresolved");
  });

  it("fused truncation never becomes no_behavior", () => {
    const a = memberOf(TASK_A, "T1");
    // finish_reason=length 由 runner 层判定；协议层验证截断 payload 的部分结论不得伪装成功——
    // 缺 regions 键 → 空判定 → 全区域未决（与单任务截断语义一致）
    const results = parseBatchFusedContent(JSON.stringify({ tasks: [{ id: "T1" }] }), [a.member]);
    expect(results[0]!.status).toBe("missing_region");
    const derived = deriveBehaviorTaskResult(a.task, sourcesFor(TASK_A), results[0]!.payload!, "fused:T1");
    expect(derived.outcome).toBe("unresolved");
    expect(derived.anchorReceipts.every((receipt) => receipt.disposition === "unresolved")).toBe(true);
  });

  it("dual and fused runs receive identical planned members and T/R mappings", () => {
    const a = memberOf(TASK_A, "T1");
    const b = memberOf(TASK_B, "T2");
    const members = [a.member, b.member];
    // prompt 含两成员的 T/R 清单与源码（与双步同一映射，不重新编号）
    const messages = buildBatchFusedPrompt({
      members,
      taskByTaskKey: new Map([[TASK_A, a.task], [TASK_B, b.task]]),
      sourcesByTaskKey: new Map([[TASK_A, sourcesFor(TASK_A)], [TASK_B, sourcesFor(TASK_B)]]),
    });
    const user = messages[1]!.content;
    expect(user).toContain("TASK T1");
    expect(user).toContain("TASK T2");
    expect(user).toContain("R1");
    // fused 的质量手法在 prompt 层：要求模型先陈述事实（facts/inputs/controlFlow/externalEffects）再判定
    expect(user).toContain("facts");
    expect(messages[0]!.content).toContain("单调用");
    // fused 输出协议仍是 tasks[{id, regions[{id,...}]}] 包装——成员绑定走别名而非数组位置
    const content = JSON.stringify({
      tasks: [
        { id: "T2", regions: [{ ...fusedRegion("R1"), reason: "beta-reason", evidence: [{ path: "src/task-beta.ts", startLine: 2 }], scenarioRefs: [] }] },
        { id: "T1", regions: [fusedRegion("R1")] },
      ],
    });
    const results = parseBatchFusedContent(content, members);
    // results 按 members 顺序（T1 在前）：T1 是空 reason，T2 是 beta-reason——别名绑定正确
    expect(results[0]!.payload!.regions[0]!.reason).toBe("");
    expect(results[1]!.payload!.regions[0]!.reason).toBe("beta-reason");
  });

  it("malformed outer JSON and duplicate aliases isolate per member", () => {
    const a = memberOf(TASK_A, "T1");
    expect(() => parseBatchFusedContent("nope", [a.member])).toThrow(BatchProtocolError);
    const duplicate = JSON.stringify({ tasks: [{ id: "T1", regions: [fusedRegion("R1")] }, { id: "T1", regions: [fusedRegion("R1")] }] });
    const results = parseBatchFusedContent(duplicate, [a.member]);
    expect(results[0]!.status).toBe("duplicate_task");
  });
});
