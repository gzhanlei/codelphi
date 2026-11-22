import { describe, expect, it } from "vitest";
import type { BehaviorExecutionTask } from "../lib/behavior-inventory/types";
import type { TaskSource } from "../lib/behavior-inventory/planner";
import { makeOrderedRegionAliases } from "../lib/execution-batch/identity";
import {
  BatchProtocolError,
  buildBatchDescribePrompt,
  buildBatchJudgePrompt,
  parseBatchDescribeContent,
  parseBatchJudgeContent,
} from "../lib/execution-batch/protocol";
import { parseDescribeContent, parseJudgeContent } from "../lib/behavior-unit-ai";

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

interface MemberSpec {
  taskKey: string;
  taskAlias: string;
  regions?: number;
}

function makeMember(spec: MemberSpec) {
  const task = makeTask(spec.taskKey, spec.regions ?? 2);
  return { task, member: { taskKey: spec.taskKey, taskAlias: spec.taskAlias, orderedRegionAliases: makeOrderedRegionAliases(task) } };
}

function makeSources(taskKey: string): TaskSource[] {
  return [
    {
      path: `src/${taskKey.replace(/[|]/g, "-")}.ts`,
      role: "primary",
      content: "export function demo() {\n  return 1;\n}",
      startLine: 1,
      endLine: 3,
    },
  ];
}

function describeRegion(id: string, facts: string) {
  return { id, facts, inputs: "", controlFlow: "", externalEffects: "" };
}

function judgeRegion(id: string, scenarioRefs: string[] = ["HP-1"]) {
  return { id, disposition: "extracted", evidence: [{ path: "src/a.ts", startLine: 1 }], scenarioRefs };
}

const TASK_A = "task|alpha";
const TASK_B = "task|beta";

function setup(): ReturnType<typeof buildMembers> {
  return buildMembers();
}

function buildMembers() {
  const a = makeMember({ taskKey: TASK_A, taskAlias: "T1" });
  const b = makeMember({ taskKey: TASK_B, taskAlias: "T2" });
  return { a, b, members: [a.member, b.member] };
}

function describeFixture(aFacts: [string, string], bFacts: [string, string]): string {
  return JSON.stringify({
    tasks: [
      { id: "T1", regions: [describeRegion("R1", aFacts[0]), describeRegion("R2", aFacts[1])] },
      { id: "T2", regions: [describeRegion("R1", bFacts[0]), describeRegion("R2", bFacts[1])] },
    ],
  });
}

describe("execution batch protocol parsing (Task 5)", () => {
  it("round trips each task payload through existing single task parsers", () => {
    const { members } = setup();
    const content = describeFixture(["alpha-1", "alpha-2"], ["beta-1", "beta-2"]);
    const results = parseBatchDescribeContent(content, members);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ taskKey: TASK_A, taskAlias: "T1", status: "ok" });
    expect(results[1]).toMatchObject({ taskKey: TASK_B, taskAlias: "T2", status: "ok" });
    // 与直接调用单任务解析器深度等价（无损转换契约）
    const singleTask = makeTask(TASK_A);
    const expected = parseDescribeContent(
      JSON.stringify({ regions: [describeRegion("R1", "alpha-1"), describeRegion("R2", "alpha-2")] }),
      singleTask,
    );
    expect(results[0]!.payload).toEqual(expected);
  });

  it("round trips judge payloads including features through the existing judge parser", () => {
    const { members } = setup();
    const content = JSON.stringify({
      tasks: [
        {
          id: "T1",
          regions: [judgeRegion("R1"), judgeRegion("R2")],
          features: [
            {
              name: "Demo",
              summary: "demo feature",
              scenarios: [
                { reference: "HP-1", context: "ctx", action: "act", outcome: "out", category: "happy", step: 1, evidence: [{ path: "src/a.ts", startLine: 1 }] },
              ],
            },
          ],
        },
        { id: "T2", regions: [judgeRegion("R1", []), judgeRegion("R2", [])], features: [] },
      ],
    });
    const results = parseBatchJudgeContent(content, members);
    expect(results[0]!.status).toBe("ok");
    expect(results[1]!.status).toBe("ok");
    const singleExpected = parseJudgeContent(
      JSON.stringify({
        regions: [judgeRegion("R1"), judgeRegion("R2")],
        features: [
          {
            name: "Demo",
            summary: "demo feature",
            scenarios: [
              { reference: "HP-1", context: "ctx", action: "act", outcome: "out", category: "happy", step: 1, evidence: [{ path: "src/a.ts", startLine: 1 }] },
            ],
          },
        ],
      }),
      makeTask(TASK_A),
    );
    expect(results[0]!.payload).toEqual(singleExpected);
  });

  it("uses persisted T and R aliases rather than array position identity", () => {
    // 成员数组顺序打乱（T2 在前），返回仍按别名绑定 taskKey
    const { a, b } = setup();
    const results = parseBatchDescribeContent(describeFixture(["alpha-1", "alpha-2"], ["beta-1", "beta-2"]), [b.member, a.member]);
    expect(results[0]).toMatchObject({ taskKey: TASK_B, taskAlias: "T2", status: "ok" });
    expect(results[0]!.payload).toEqual([describeRegion("R1", "beta-1"), describeRegion("R2", "beta-2")]);
    expect(results[1]).toMatchObject({ taskKey: TASK_A, taskAlias: "T1", status: "ok" });
    // batch JSON 内任务条目顺序与成员顺序也不一致时，别名仍是唯一绑定
    const shuffled = JSON.stringify({
      tasks: [
        { id: "T2", regions: [describeRegion("R1", "beta-1"), describeRegion("R2", "beta-2")] },
        { id: "T1", regions: [describeRegion("R1", "alpha-1"), describeRegion("R2", "alpha-2")] },
      ],
    });
    const byAlias = parseBatchDescribeContent(shuffled, [b.member, a.member]);
    expect(byAlias[0]!.payload).toEqual([describeRegion("R1", "beta-1"), describeRegion("R2", "beta-2")]);
    expect(byAlias[1]!.payload).toEqual([describeRegion("R1", "alpha-1"), describeRegion("R2", "alpha-2")]);
  });

  it("rejects duplicate task or region aliases only for the affected task", () => {
    const { members } = setup();
    const duplicateTask = JSON.stringify({
      tasks: [
        { id: "T1", regions: [describeRegion("R1", "x"), describeRegion("R2", "y")] },
        { id: "T1", regions: [describeRegion("R1", "dup")] },
        { id: "T2", regions: [describeRegion("R1", "beta-1"), describeRegion("R2", "beta-2")] },
      ],
    });
    const taskResults = parseBatchDescribeContent(duplicateTask, members);
    expect(taskResults[0]).toMatchObject({ taskAlias: "T1", status: "duplicate_task" });
    expect(taskResults[1]).toMatchObject({ taskKey: TASK_B, taskAlias: "T2", status: "ok" });
    const duplicateRegion = JSON.stringify({
      tasks: [
        { id: "T1", regions: [describeRegion("R1", "alpha-1"), describeRegion("R1", "alpha-dup"), describeRegion("R2", "alpha-2")] },
        { id: "T2", regions: [describeRegion("R1", "beta-1"), describeRegion("R2", "beta-2")] },
      ],
    });
    const regionResults = parseBatchDescribeContent(duplicateRegion, members);
    expect(regionResults[0]).toMatchObject({ taskAlias: "T1", status: "duplicate_region" });
    expect(regionResults[1]).toMatchObject({ taskAlias: "T2", status: "ok" });
  });

  it("keeps cross task evidence and scenario references isolated", () => {
    const { a, members } = setup();
    const threeRegionB = makeMember({ taskKey: TASK_B, taskAlias: "T2", regions: 3 });
    const content = JSON.stringify({
      tasks: [
        {
          id: "T1",
          regions: [
            judgeRegion("R1"),
            judgeRegion("R2", []),
            // 跨任务 region id（T2 的 R3）：对 T1 是未知 id，被丢弃并记录诊断，不影响 T1 合法区域
            judgeRegion("R3", ["HP-2"]),
          ],
          features: [{ name: "AlphaOnly", summary: "s", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", step: 1, evidence: [{ path: "src/a.ts", startLine: 1 }] }] }],
        },
        { id: "T2", regions: [judgeRegion("R1", []), judgeRegion("R2", []), judgeRegion("R3", [])], features: [] },
      ],
    });
    const results = parseBatchJudgeContent(content, [a.member, threeRegionB.member]);
    expect(results[0]!.status).toBe("ok");
    expect(results[0]!.payload!.regions.map((region) => region.id).sort()).toEqual(["R1", "R2"]);
    expect(results[0]!.diagnostics?.join(" ")).toContain("R3");
    // T1 的场景引用不泄漏到 T2：T2 的 payload 与其自身内容等价
    expect(results[1]!.status).toBe("ok");
    expect(results[1]!.payload!.features).toEqual([]);
  });

  it("missing task and missing region remain unresolved inputs not no_behavior", () => {
    const { members } = setup();
    const content = JSON.stringify({
      tasks: [{ id: "T1", regions: [describeRegion("R1", "alpha-1")] }],
    });
    const results = parseBatchDescribeContent(content, members);
    // 缺整个 task → 该 task 的所有区域未决（解析层只标 missing_task，不产生任何 no_behavior 事实）
    expect(results[1]).toMatchObject({ taskKey: TASK_B, taskAlias: "T2", status: "missing_task" });
    // 缺单 region → 仅该 task 标 missing_region
    expect(results[0]).toMatchObject({ taskAlias: "T1", status: "missing_region" });
    expect(results.every((result) => result.status !== "ok")).toBe(true);
  });

  it("throws BatchProtocolError for malformed outer JSON and keeps per-task failures isolated", () => {
    const { members } = setup();
    expect(() => parseBatchDescribeContent("not json {", members)).toThrow(BatchProtocolError);
    expect(() => parseBatchJudgeContent("{\"tasks\": \"not-an-array\"}", members)).toThrow(BatchProtocolError);
    // 未知 task ID：忽略并记录诊断，不影响合法成员
    const unknownAlias = JSON.stringify({
      tasks: [
        { id: "T9", regions: [describeRegion("R1", "ghost")] },
        { id: "T1", regions: [describeRegion("R1", "alpha-1"), describeRegion("R2", "alpha-2")] },
        { id: "T2", regions: [describeRegion("R1", "beta-1"), describeRegion("R2", "beta-2")] },
      ],
    });
    const results = parseBatchDescribeContent(unknownAlias, members);
    expect(results.filter((result) => result.status === "ok")).toHaveLength(2);
    expect(results.find((result) => result.status === "unknown_alias")).toMatchObject({ taskAlias: "T9", taskKey: null });
  });
});

describe("execution batch protocol prompts (Task 5)", () => {
  it("builds a batch describe prompt embedding each member's single-task body", () => {
    const { a, b, members } = setup();
    const messages = buildBatchDescribePrompt({
      members,
      taskByTaskKey: new Map([[TASK_A, a.task], [TASK_B, b.task]]),
      sourcesByTaskKey: new Map([[TASK_A, makeSources(TASK_A)], [TASK_B, makeSources(TASK_B)]]),
    });
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    const system = messages[0]!.content;
    expect(system).toContain("T1");
    expect(system).toContain("T2");
    const user = messages[1]!.content;
    // 每个成员的分节与单任务体（区域清单 + 源码）都在
    expect(user).toContain("TASK T1");
    expect(user).toContain("TASK T2");
    expect(user).toContain("src/task-alpha.ts");
    expect(user).toContain("src/task-beta.ts");
    expect(user).toContain("R1");
    expect(user).toContain("R2");
  });

  it("judge prompt binds the describe response hash and the identical member mapping", () => {
    const { a, b, members } = setup();
    const describeHash = "abc123";
    const messages = buildBatchJudgePrompt({
      members,
      taskByTaskKey: new Map([[TASK_A, a.task], [TASK_B, b.task]]),
      sourcesByTaskKey: new Map([[TASK_A, makeSources(TASK_A)], [TASK_B, makeSources(TASK_B)]]),
      describeResponseHash: describeHash,
      descriptionsByTaskKey: new Map([
        [TASK_A, [describeRegion("R1", "alpha-1"), describeRegion("R2", "alpha-2")]],
        [TASK_B, [describeRegion("R1", "beta-1"), describeRegion("R2", "beta-2")]],
      ]),
    });
    const joined = messages.map((message) => message.content).join("\n");
    // describe 响应 hash 显式绑定
    expect(joined).toContain(describeHash);
    // 成员映射与 describe 完全一致（别名 + 区域清单）
    expect(joined).toContain("TASK T1");
    expect(joined).toContain("TASK T2");
    expect(joined).toContain("src/task-alpha.ts");
    expect(joined).toContain("src/task-beta.ts");
  });
});
