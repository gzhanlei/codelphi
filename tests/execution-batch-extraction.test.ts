import { describe, expect, it } from "vitest";
import type { TaskSource } from "../lib/behavior-inventory/planner";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";
import { makeOrderedRegionAliases } from "../lib/execution-batch/identity";
import { extractBehaviorBatch, type ExtractBatchInput } from "../lib/execution-batch/extraction";

const PARSER_VERSION = "1";

function makeTask(taskKey: string, regionCount = 2): BehaviorExecutionTask {
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

function sourcesFor(taskKey: string): TaskSource[] {
  const path = `src/${taskKey.replace(/[|]/g, "-")}.ts`;
  return [
    { path, role: "primary", content: "export function demo() {\n  return 1;\n}", startLine: 1, endLine: 3 },
  ];
}

interface MemberSpec {
  taskKey: string;
  taskAlias: string;
}

function memberOf(spec: MemberSpec) {
  const task = makeTask(spec.taskKey);
  return { task, sources: sourcesFor(spec.taskKey), member: { taskKey: spec.taskKey, taskAlias: spec.taskAlias, orderedRegionAliases: makeOrderedRegionAliases(task) } };
}

const KEYS = ["task|one", "task|two", "task|three", "task|four", "task|five", "task|six"];

function setupSix(): ReturnType<typeof buildSix> {
  return buildSix();
}

function buildSix() {
  const entries = KEYS.map((taskKey, index) => memberOf({ taskKey, taskAlias: `T${index + 1}` }));
  return {
    entries,
    members: entries.map((entry) => entry.member),
    taskByTaskKey: new Map(entries.map((entry) => [entry.member.taskKey, entry.task])),
    sourcesByTaskKey: new Map(entries.map((entry) => [entry.member.taskKey, entry.sources])),
  };
}

/** 合法成员判定载荷：R1 extracted（场景证据引用本任务文件）+ R2 reviewed_internal（合规）→ outcome=extracted。 */
function validJudgeRegions(taskKey: string, scenarioRef = "HP-1"): Array<Record<string, unknown>> {
  const primary = `src/${taskKey.replace(/[|]/g, "-")}.ts`;
  return [
    {
      id: "R1",
      disposition: "extracted",
      evidence: [{ path: primary, startLine: 2 }],
      scenarioRefs: [scenarioRef],
    },
    {
      id: "R2",
      disposition: "reviewed_internal",
      internalKind: "pure_technical",
      reason: "internal plumbing",
      evidence: [{ path: primary, startLine: 2 }],
      scenarioRefs: [],
    },
  ];
}

function validFeature(reference: string, taskKey: string): Record<string, unknown> {
  return {
    name: `feature-${reference}`,
    summary: "demo",
    scenarios: [
      { reference, context: "ctx", action: "act", outcome: "out", category: "happy", step: 1, evidence: [{ path: `src/${taskKey.replace(/[|]/g, "-")}.ts`, startLine: 2 }] },
    ],
  };
}

function judgeFixture(perTask: Record<string, unknown>): string {
  return JSON.stringify({ tasks: Object.entries(perTask).map(([id, value]) => ({ id, ...(value as Record<string, unknown>) })) });
}

function allValidJudge(except?: { alias: string; override: Record<string, unknown> }): string {
  const perTask: Record<string, unknown> = {};
  KEYS.forEach((_, index) => {
    const alias = `T${index + 1}`;
    perTask[alias] = except?.alias === alias ? except.override : { regions: validJudgeRegions(KEYS[index]!), features: [validFeature(`HP-${index + 1}`, KEYS[index]!)] };
  });
  return judgeFixture(perTask);
}

function describeFixtureValid(): string {
  return JSON.stringify({
    tasks: KEYS.map((taskKey, index) => ({
      id: `T${index + 1}`,
      regions: [
        { id: "R1", facts: `${taskKey} r1 facts`, inputs: "", controlFlow: "", externalEffects: "" },
        { id: "R2", facts: `${taskKey} r2 facts`, inputs: "", controlFlow: "", externalEffects: "" },
      ],
    })),
  });
}

function baseInput(overrides: Partial<ExtractBatchInput> = {}): ExtractBatchInput {
  const { members, taskByTaskKey, sourcesByTaskKey } = setupSix();
  return {
    members,
    taskByTaskKey,
    sourcesByTaskKey,
    describeRaw: describeFixtureValid(),
    judgeRaw: allValidJudge(),
    describeTruncated: false,
    judgeTruncated: false,
    parserVersion: PARSER_VERSION,
    ...overrides,
  };
}

describe("execution batch extraction (Task 7)", () => {
  it("five valid tasks commit eligible results while one missing region stays unresolved", () => {
    // task|six（T6）缺 R2 结论：仅该成员出现未决区域，其余五个仍是可提交的 derived 结果
    const missingRegion = judgeFixture({
      ...Object.fromEntries(KEYS.slice(0, 5).map((taskKey, index) => [`T${index + 1}`, { regions: validJudgeRegions(taskKey, `HP-${index + 1}`), features: [validFeature(`HP-${index + 1}`, KEYS[index]!)] }])),
      T6: { regions: [validJudgeRegions("task|six", "HP-6")[0]!], features: [validFeature("HP-6", "task|six")] },
    });
    const outcome = extractBehaviorBatch(baseInput({ judgeRaw: missingRegion }));
    expect(outcome.results).toHaveLength(6);
    const derived = outcome.results.filter((result) => result.status === "derived");
    expect(derived).toHaveLength(6);
    const commitEligible = derived.filter((result) => result.result?.outcome === "extracted");
    expect(commitEligible.map((result) => result.taskAlias).sort()).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    const unresolvedMember = outcome.results.find((result) => result.taskAlias === "T6")!;
    expect(unresolvedMember.result?.outcome).toBe("unresolved");
    expect(unresolvedMember.result?.unresolvedAnchorCount).toBe(1);
    // unresolved 不进入可提交集合：R1/R2/R3 分母纪律由 Task 8 落实，这里只保证结果事实诚实
    expect(outcome.results.some((result) => result.result?.outcome === "no_behavior")).toBe(false);
  });

  it("task evidence allow set does not include sibling task files", () => {
    // T1 的场景证据引用 task-two 的文件：越界证据被清洗，成员不伪装成功
    const crossEvidence = judgeFixture({
      T1: {
        regions: [
          { id: "R1", disposition: "extracted", evidence: [{ path: "src/task-two.ts", startLine: 2 }], scenarioRefs: ["HP-1"] },
          { id: "R2", disposition: "reviewed_internal", internalKind: "pure_technical", reason: "r", evidence: [{ path: "src/task-one.ts", startLine: 2 }], scenarioRefs: [] },
        ],
        features: [
          {
            name: "Cross",
            summary: "s",
            scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: "src/task-two.ts", startLine: 2 }] }],
          },
        ],
      },
      ...Object.fromEntries(KEYS.slice(1).map((taskKey, index) => [`T${index + 2}`, { regions: validJudgeRegions(taskKey, `HP-${index + 2}`), features: [validFeature(`HP-${index + 2}`, taskKey)] }])),
    });
    const outcome = extractBehaviorBatch(baseInput({ judgeRaw: crossEvidence }));
    const t1 = outcome.results.find((result) => result.taskAlias === "T1")!;
    expect(t1.status).toBe("derived");
    expect(t1.result?.outcome).toBe("unresolved");
    const serialized = JSON.stringify(t1.result);
    expect(serialized).not.toContain("src/task-two.ts");
  });

  it("describe length skips judge and marks every member output_truncated", () => {
    const outcome = extractBehaviorBatch(baseInput({ describeTruncated: true, judgeRaw: null }));
    expect(outcome.results).toHaveLength(6);
    for (const result of outcome.results) {
      expect(result.status).toBe("truncated");
      expect(result.result?.outcome).toBe("unresolved");
      expect(result.result?.anchorReceipts.every((receipt) => receipt.disposition === "unresolved")).toBe(true);
      expect(result.reason).toContain("describe");
    }
  });

  it("judge length accepts no partial task success", () => {
    // judge 截断时即使 JSON 看似完整也不接受任何成员成功
    const outcome = extractBehaviorBatch(baseInput({ judgeTruncated: true }));
    expect(outcome.results).toHaveLength(6);
    for (const result of outcome.results) {
      expect(result.status).toBe("truncated");
      expect(result.result?.outcome).toBe("unresolved");
      expect(result.reason).toContain("judge");
    }
    expect(outcome.results.every((result) => result.result?.outcome === "unresolved")).toBe(true);
  });

  it("complete json with missing task is not treated as complete batch coverage", () => {
    // judge JSON 语法完整但缺 T6 整个任务：T6 全区域未决，绝不伪装批次完整覆盖
    const missingTask = judgeFixture(
      Object.fromEntries(KEYS.slice(0, 5).map((taskKey, index) => [`T${index + 1}`, { regions: validJudgeRegions(taskKey, `HP-${index + 1}`), features: [validFeature(`HP-${index + 1}`, KEYS[index]!)] }])),
    );
    const outcome = extractBehaviorBatch(baseInput({ judgeRaw: missingTask }));
    const t6 = outcome.results.find((result) => result.taskAlias === "T6")!;
    expect(t6.status).toBe("derived");
    expect(t6.result?.outcome).toBe("unresolved");
    expect(t6.reason).toContain("T6");
    const extracted = outcome.results.filter((result) => result.result?.outcome === "extracted");
    expect(extracted).toHaveLength(5);
  });

  it("same raw response and parser version derives the same result fingerprint", () => {
    const first = extractBehaviorBatch(baseInput());
    const second = extractBehaviorBatch(baseInput());
    expect(second.resultFingerprint).toBe(first.resultFingerprint);
    expect(first.resultFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const changed = extractBehaviorBatch(baseInput({ judgeRaw: allValidJudge({ alias: "T3", override: { regions: validJudgeRegions("task|three", "HP-3"), features: [] } }) }));
    expect(changed.resultFingerprint).not.toBe(first.resultFingerprint);
  });
});
