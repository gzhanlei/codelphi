import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import type { BehaviorAnchor, BehaviorAnchorFragment, BehaviorExecutionTask, BehaviorUnit } from "../lib/behavior-inventory/types";
import type { BehaviorFragmentReceipt } from "../lib/behavior-unit-extraction";
import {
  aggregateBehaviorUnitStatus,
  assignLocalScenarioKeys,
  assignLocalScenarioKeysWithAliases,
  buildAnchorScenarioLinks,
  type UnitTaskState,
} from "../lib/behavior-unit-state";

const unitKey = 'unit|http|[["GET","/api/orders","app/api/orders/route.ts","createOrder"]]';
const anchorA = 'anchor|behavior|[["app/api/orders/route.ts","createOrder",[[10,80]]]]';
const anchorB = 'anchor|implicit_review|[["app/api/orders/route.ts",null,[[81,120]]]]';
const entryAnchor = 'anchor|entry|[["app/api/orders/route.ts","createOrder",[[1,9]]]]';

type Feature = AnalysisResult["features"][number];
type Scenario = Feature["scenarios"][number];

function makeUnit(anchors: BehaviorAnchor[]): BehaviorUnit {
  return {
    unitKey,
    kind: "http",
    primaryPath: "app/api/orders/route.ts",
    primaryRanges: [{ startLine: 1, endLine: 200 }],
    contextRanges: [],
    anchors,
    detector: "next-route",
    detectorVersion: "1.0.0",
  };
}

function anchor(anchorKey: string, role: BehaviorAnchor["role"]): BehaviorAnchor {
  return { anchorKey, role, ranges: [{ startLine: 10, endLine: 80 }], evidence: [{ path: "app/api/orders/route.ts", startLine: 10 }], coarse: false };
}

function fragment(anchorKey: string, ordinal: number): BehaviorAnchorFragment {
  return {
    anchorKey,
    anchorFragmentKey: `fragment|${JSON.stringify([anchorKey, [[ordinal * 10, ordinal * 10 + 9]], ordinal])}`,
    ranges: [{ startLine: ordinal * 10, endLine: ordinal * 10 + 9 }],
  };
}

function makeTask(unit: BehaviorUnit, ordinal: number, anchorFragments: BehaviorAnchorFragment[]): BehaviorExecutionTask {
  return { taskKey: `task|${JSON.stringify([unit.unitKey, ordinal])}`, unitKey: unit.unitKey, anchorFragments };
}

function scenario(reference: string, overrides: Partial<Scenario> = {}): Scenario {
  return {
    reference,
    context: `情境 ${reference}`,
    action: `操作 ${reference}`,
    outcome: `结果 ${reference}`,
    category: "happy",
    evidence: [{ path: "app/api/orders/route.ts", startLine: 10 }],
    ...overrides,
  };
}

function feature(name: string, scenarios: Scenario[]): Feature {
  return { name, summary: `${name} 摘要`, scenarios };
}

function extractedReceipt(frag: BehaviorAnchorFragment, refs: string[]): BehaviorFragmentReceipt {
  return {
    anchorKey: frag.anchorKey,
    anchorFragmentKey: frag.anchorFragmentKey,
    disposition: "extracted",
    evidence: [{ path: "app/api/orders/route.ts", startLine: frag.ranges[0].startLine }],
    scenarioRefs: refs,
  };
}

function internalReceipt(frag: BehaviorAnchorFragment): BehaviorFragmentReceipt {
  return {
    anchorKey: frag.anchorKey,
    anchorFragmentKey: frag.anchorFragmentKey,
    disposition: "reviewed_internal",
    internalKind: "data_transform",
    evidence: [{ path: "app/api/orders/route.ts", startLine: frag.ranges[0].startLine }],
    scenarioRefs: [],
  };
}

function unresolvedReceipt(frag: BehaviorAnchorFragment, reason = "missing_disposition"): BehaviorFragmentReceipt {
  return {
    anchorKey: frag.anchorKey,
    anchorFragmentKey: frag.anchorFragmentKey,
    disposition: "unresolved",
    reason,
    evidence: [],
    scenarioRefs: [],
  };
}

function taskState(
  task: BehaviorExecutionTask,
  status: UnitTaskState["status"],
  receipts: BehaviorFragmentReceipt[] = [],
  features: Feature[] = [],
): UnitTaskState {
  if (status === "pending" || status === "running" || status === "failed") return { task, status, result: null };
  return { task, status, result: { outcome: status, features, anchorReceipts: receipts } };
}

describe("assignLocalScenarioKeys", () => {
  it("assigns zero-padded ordinals by evidence, category and normalized behavior text", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag = fragment(anchorA, 1);
    const task = makeTask(unit, 1, [frag]);
    const features = [
      feature("订单管理", [
        scenario("ER-1", { category: "error", context: "库存不足", action: "提交订单", outcome: "返回库存不足错误", evidence: [{ path: "app/api/orders/route.ts", startLine: 50 }] }),
        scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" }),
        scenario("EC-1", { category: "edge", context: "用户在订单页", action: "提交空地址订单", outcome: "提示地址必填" }),
      ]),
    ];
    // 引用顺序故意打乱：ordinal 只能来自确定性排序，不来自 AI 编号或输入顺序
    const assignments = assignLocalScenarioKeys({ unit, tasks: [taskState(task, "extracted", [extractedReceipt(frag, ["ER-1", "HP-1", "EC-1"])], features)] });
    expect(assignments.map((assignment) => assignment.ordinal)).toEqual([1, 2, 3]);
    // 证据 path/startLine 先排（line 10 先于 line 50），同行再按 category 码点序（edge < happy）
    expect(assignments.map((assignment) => assignment.reference)).toEqual(["EC-1", "HP-1", "ER-1"]);
    expect(assignments.map((assignment) => assignment.localScenarioKey)).toEqual([
      `scenario|${JSON.stringify([unitKey, anchorA, "001"])}`,
      `scenario|${JSON.stringify([unitKey, anchorA, "002"])}`,
      `scenario|${JSON.stringify([unitKey, anchorA, "003"])}`,
    ]);
    for (const assignment of assignments) {
      expect(assignment.unitKey).toBe(unitKey);
      expect(assignment.anchorKey).toBe(anchorA);
      expect(assignment.linkedAnchorKeys).toEqual([anchorA]);
      // 身份不含 AI 的 feature 名称与 HP/EC/ER 引用——它们只是内容字段
      expect(assignment.localScenarioKey).not.toContain("订单管理");
      expect(assignment.localScenarioKey).not.toContain(assignment.reference);
    }
    const links = buildAnchorScenarioLinks({ runId: 7, unitKey, assignments });
    expect(links).toHaveLength(3);
    expect(new Set(links.map((link) => `${link.anchorKey}${link.localScenarioKey}`)).size).toBe(links.length);
  });

  it("keeps identity stable when AI renames features and references", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag = fragment(anchorA, 1);
    const task = makeTask(unit, 1, [frag]);
    const v1 = assignLocalScenarioKeys({
      unit,
      tasks: [taskState(task, "extracted", [extractedReceipt(frag, ["HP-1"])], [
        feature("订单管理", [scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })]),
      ])],
    });
    const v2 = assignLocalScenarioKeys({
      unit,
      tasks: [taskState(task, "extracted", [extractedReceipt(frag, ["HP-7"])], [
        feature("订单中心", [scenario("HP-7", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })]),
      ])],
    });
    // AI 改名/改编号不改变局部身份；名称与引用仅作为内容保留在 assignment 上
    expect(v2.map((assignment) => assignment.localScenarioKey)).toEqual(v1.map((assignment) => assignment.localScenarioKey));
    expect(v2[0].featureName).toBe("订单中心");
    expect(v2[0].reference).toBe("HP-7");
  });

  it("dedupes behavior-equal scenarios across fragments of one anchor before assigning ordinals", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    const task1 = makeTask(unit, 1, [frag1]);
    const task2 = makeTask(unit, 2, [frag2]);
    // 同一锚点的两个分片各自提取到同一行为（仅空白差异，规范化后等价）
    const assignments = assignLocalScenarioKeys({
      unit,
      tasks: [
        taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1"])], [
          feature("订单管理", [scenario("HP-1", { context: "用户  登录后", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
        taskState(task2, "extracted", [extractedReceipt(frag2, ["HP-1"])], [
          feature("订单管理", [scenario("HP-1", { context: "用户 登录后", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
      ],
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].ordinal).toBe(1);
    expect(assignments[0].linkedAnchorKeys).toEqual([anchorA]);
    const links = buildAnchorScenarioLinks({ runId: 7, unitKey, assignments });
    expect(links).toEqual([{ runId: 7, unitKey, anchorKey: anchorA, localScenarioKey: assignments[0].localScenarioKey }]);
  });

  it("is deterministic regardless of task and reference order in the persisted result", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    const task1 = makeTask(unit, 1, [frag1]);
    const task2 = makeTask(unit, 2, [frag2]);
    const features1 = [feature("订单管理", [scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })])];
    const features2 = [feature("库存", [scenario("EC-1", { category: "edge", context: "库存不足", action: "提交订单", outcome: "返回错误", evidence: [{ path: "app/api/orders/route.ts", startLine: 50 }] })])];
    const first = assignLocalScenarioKeys({
      unit,
      tasks: [
        taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1"])], features1),
        taskState(task2, "extracted", [extractedReceipt(frag2, ["EC-1"])], features2),
      ],
    });
    // 任务数组顺序与引用顺序不同（同一持久化结果的另一种读出顺序），分配必须逐字节一致
    const second = assignLocalScenarioKeys({
      unit,
      tasks: [
        taskState(task2, "extracted", [extractedReceipt(frag2, ["EC-1"])], features2),
        taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1"])], features1),
      ],
    });
    expect(second).toEqual(first);
  });

  it("links multiple anchors to one local scenario when they support the same behavior", () => {
    const unit = makeUnit([anchor(anchorA, "behavior"), anchor(anchorB, "implicit_review")]);
    const fragA = fragment(anchorA, 1);
    const fragB = fragment(anchorB, 1);
    const task1 = makeTask(unit, 1, [fragA]);
    const task2 = makeTask(unit, 2, [fragB]);
    // 同一行为、不同 category（BM-5：category 只是呈现标签）与不同引用
    const assignments = assignLocalScenarioKeys({
      unit,
      tasks: [
        taskState(task1, "extracted", [extractedReceipt(fragA, ["HP-1"])], [
          feature("订单管理", [scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
        taskState(task2, "extracted", [extractedReceipt(fragB, ["EC-1"])], [
          feature("订单管理", [scenario("EC-1", { category: "edge", context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
      ],
    });
    expect(assignments).toHaveLength(1);
    // 归属锚点 = 码点序最小者（behavior < implicit_review），序号在其局部集合内分配
    expect(assignments[0].anchorKey).toBe(anchorA);
    expect(assignments[0].ordinal).toBe(1);
    expect(assignments[0].linkedAnchorKeys).toEqual([anchorA, anchorB]);
    const links = buildAnchorScenarioLinks({ runId: 7, unitKey, assignments });
    expect(links).toEqual([
      { runId: 7, unitKey, anchorKey: anchorA, localScenarioKey: assignments[0].localScenarioKey },
      { runId: 7, unitKey, anchorKey: anchorB, localScenarioKey: assignments[0].localScenarioKey },
    ]);
  });

  it("replaces the anchor's local scenario set wholesale on retry instead of appending ordinals", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    const task1 = makeTask(unit, 1, [frag1]);
    const task2 = makeTask(unit, 2, [frag2]);
    const state1 = taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1", "EC-1"])], [
      feature("订单管理", [
        scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" }),
        scenario("EC-1", { category: "edge", context: "用户在订单页", action: "提交空地址", outcome: "提示地址必填" }),
      ]),
    ]);
    const staleScenario = scenario("HP-1", { context: "库存不足", action: "提交订单", outcome: "返回错误", evidence: [{ path: "app/api/orders/route.ts", startLine: 50 }] });
    const v1 = assignLocalScenarioKeys({
      unit,
      tasks: [state1, taskState(task2, "extracted", [extractedReceipt(frag2, ["HP-1"])], [feature("库存", [staleScenario])])],
    });
    expect(v1).toHaveLength(3);
    // 重试：task2 的持久化结果被整体替换（Task 8 条件提交覆盖 result_json），局部集合全量重算
    const v2 = assignLocalScenarioKeys({
      unit,
      tasks: [
        state1,
        taskState(task2, "extracted", [extractedReceipt(frag2, ["HP-1"])], [
          feature("库存", [scenario("HP-1", { context: "库存为零", action: "提交订单", outcome: "返回缺货错误", evidence: [{ path: "app/api/orders/route.ts", startLine: 55 }] })]),
        ]),
      ],
    });
    // 旧结果的场景不残留；新集合从 001 重排，绝不向旧集合追加新 ordinal
    expect(v2).toHaveLength(3);
    expect(v2.map((assignment) => assignment.ordinal)).toEqual([1, 2, 3]);
    expect(v2.some((assignment) => assignment.scenario.outcome === "返回错误")).toBe(false);
    expect(v2.some((assignment) => assignment.scenario.outcome === "返回缺货错误")).toBe(true);
  });

  it("assigns keys only after every fragment of the anchor is terminal", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    const task1 = makeTask(unit, 1, [frag1]);
    const task2 = makeTask(unit, 2, [frag2]);
    const done = taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1"])], [
      feature("订单管理", [scenario("HP-1")]),
    ]);
    // 分片 2 仍 pending：锚点未完成，不分配任何局部场景
    expect(assignLocalScenarioKeys({ unit, tasks: [done, taskState(task2, "pending")] })).toEqual([]);
    // 分片 2 被租约领取中同样未完成——任何 worker 不得凭单个任务核销整个锚点
    expect(assignLocalScenarioKeys({ unit, tasks: [done, taskState(task2, "running")] })).toEqual([]);
  });

  it("produces no identities or links for reviewed_internal and unresolved receipts", () => {
    const unit = makeUnit([anchor(anchorA, "behavior"), anchor(anchorB, "implicit_review")]);
    const fragA = fragment(anchorA, 1);
    const fragB = fragment(anchorB, 1);
    const assignments = assignLocalScenarioKeys({
      unit,
      tasks: [
        taskState(makeTask(unit, 1, [fragA]), "no_behavior", [internalReceipt(fragA)]),
        taskState(makeTask(unit, 2, [fragB]), "unresolved", [unresolvedReceipt(fragB)]),
      ],
    });
    // reviewed_internal 没有 scenarioRefs、unresolved 永不计入完成：两者都不产生身份与关联
    expect(assignments).toEqual([]);
    expect(buildAnchorScenarioLinks({ runId: 7, unitKey, assignments })).toEqual([]);
  });
});

describe("assignLocalScenarioKeysWithAliases (dedup candidate refs)", () => {
  it("aliases deduped candidates' (taskKey, reference) to the surviving keeper assignment", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    const task1 = makeTask(unit, 1, [frag1]);
    const task2 = makeTask(unit, 2, [frag2]);
    // 同一锚点的两个分片提取到行为等价场景（仅空白差异）：一个存活为 assignment，另一个被去重丢弃。
    // keeper 由确定性排序决定，不由输入顺序预设——断言按 assignment 的实际身份反推被丢弃方。
    const { assignments, refAliases } = assignLocalScenarioKeysWithAliases({
      unit,
      tasks: [
        taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1"])], [
          feature("订单管理", [scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
        taskState(task2, "extracted", [extractedReceipt(frag2, ["HP-2"])], [
          feature("订单管理", [scenario("HP-2", { reference: "HP-2", context: "用户 在订单页", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
      ],
    });
    expect(assignments).toHaveLength(1);
    const keeperKey = `${assignments[0].taskKey}\n${assignments[0].reference}`;
    const droppedKey = assignments[0].taskKey === task1.taskKey ? `${task2.taskKey}\nHP-2` : `${task1.taskKey}\nHP-1`;
    // covered_elsewhere 回执引用被去重丢弃的候选时，经别名解析到 keeper 的局部场景身份
    expect(refAliases.get(droppedKey)).toBe(assignments[0].localScenarioKey);
    // keeper 自己有直查映射（full-analysis 的 localKeyByTaskRef），不需要别名
    expect(refAliases.has(keeperKey)).toBe(false);
    expect(refAliases.size).toBe(1);
  });

  it("resolves transitively when the keeper itself was linked to an earlier anchor's shared assignment", () => {
    const unit = makeUnit([anchor(anchorA, "behavior"), anchor(anchorB, "implicit_review")]);
    const fragA = fragment(anchorA, 1);
    const fragB = fragment(anchorB, 1);
    const task1 = makeTask(unit, 1, [fragA]);
    const task2 = makeTask(unit, 2, [fragB]);
    // 锚点 B 的候选与锚点 A 的 assignment 行为等价（跨锚点共享，不产生新身份）
    const { assignments, refAliases } = assignLocalScenarioKeysWithAliases({
      unit,
      tasks: [
        taskState(task1, "extracted", [extractedReceipt(fragA, ["HP-1"])], [
          feature("订单管理", [scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
        taskState(task2, "extracted", [extractedReceipt(fragB, ["HP-1"])], [
          feature("订单管理", [scenario("HP-1", { context: "用户在订单页", action: "提交订单", outcome: "订单创建成功" })]),
        ]),
      ],
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0].linkedAnchorKeys).toEqual([anchorA, anchorB]);
    // 引用者按 (task2, HP-1) 查找时仍能解析到共享 assignment 的身份
    expect(refAliases.get(`${task2.taskKey}\nHP-1`)).toBe(assignments[0].localScenarioKey);
  });

  it("keeps genuinely dead references out of the alias map (fail closed unchanged)", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag = fragment(anchorA, 1);
    const task = makeTask(unit, 1, [frag]);
    // 模型引用了持久化结果里不存在的场景（HP-9）：不产生任何别名，解析失败仍 fail closed
    const { assignments, refAliases } = assignLocalScenarioKeysWithAliases({
      unit,
      tasks: [taskState(task, "extracted", [extractedReceipt(frag, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])])],
    });
    expect(assignments).toHaveLength(1);
    expect(refAliases.size).toBe(0);
  });
});

describe("aggregateBehaviorUnitStatus", () => {
  it("stays pending until work starts and running while a lease is held", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    const task1 = makeTask(unit, 1, [frag1]);
    const task2 = makeTask(unit, 2, [frag2]);
    expect(aggregateBehaviorUnitStatus({ unit, tasks: [taskState(task1, "pending"), taskState(task2, "pending")] })).toBe("pending");
    expect(aggregateBehaviorUnitStatus({ unit, tasks: [taskState(task1, "running"), taskState(task2, "pending")] })).toBe("running");
    // 已提交一个分片、另一个仍被租约持有：锚点未完成，单元保持 running
    expect(
      aggregateBehaviorUnitStatus({
        unit,
        tasks: [
          taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])]),
          taskState(task2, "running"),
        ],
      }),
    ).toBe("running");
  });

  it("cannot complete a fragmented anchor before every fragment is terminal", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    const task1 = makeTask(unit, 1, [frag1]);
    const task2 = makeTask(unit, 2, [frag2]);
    const done1 = taskState(task1, "extracted", [extractedReceipt(frag1, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])]);
    // 只有一个分片终态：任何 worker 不得独立核销整个锚点，单元不是 extracted
    expect(aggregateBehaviorUnitStatus({ unit, tasks: [done1, taskState(task2, "pending")] })).toBe("pending");
    const done2 = taskState(task2, "extracted", [extractedReceipt(frag2, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])]);
    expect(aggregateBehaviorUnitStatus({ unit, tasks: [done1, done2] })).toBe("extracted");
  });

  it("is failed when any task has a hard failure, even with other tasks pending", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const frag1 = fragment(anchorA, 1);
    const frag2 = fragment(anchorA, 2);
    expect(
      aggregateBehaviorUnitStatus({
        unit,
        tasks: [taskState(makeTask(unit, 1, [frag1]), "failed"), taskState(makeTask(unit, 2, [frag2]), "pending")],
      }),
    ).toBe("failed");
  });

  it("is unresolved when any fragment receipt is unresolved", () => {
    const unit = makeUnit([anchor(anchorA, "behavior"), anchor(anchorB, "implicit_review")]);
    const fragA = fragment(anchorA, 1);
    const fragB = fragment(anchorB, 1);
    expect(
      aggregateBehaviorUnitStatus({
        unit,
        tasks: [
          taskState(makeTask(unit, 1, [fragA]), "extracted", [extractedReceipt(fragA, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])]),
          taskState(makeTask(unit, 2, [fragB]), "unresolved", [unresolvedReceipt(fragB, "model_unresolved")]),
        ],
      }),
    ).toBe("unresolved");
  });

  it("is unresolved when a task outcome is unresolved even if its receipts look terminal", () => {
    // 存活场景缺少 extracted 归属（D5 修复轮形态）：回执全 extracted，任务终态仍 unresolved
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    const fragA = fragment(anchorA, 1);
    expect(
      aggregateBehaviorUnitStatus({
        unit,
        tasks: [taskState(makeTask(unit, 1, [fragA]), "unresolved", [extractedReceipt(fragA, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])])],
      }),
    ).toBe("unresolved");
  });

  it("is extracted only when every accountable anchor is terminal and at least one extracted", () => {
    const unit = makeUnit([anchor(anchorA, "behavior"), anchor(anchorB, "implicit_review")]);
    const fragA = fragment(anchorA, 1);
    const fragB = fragment(anchorB, 1);
    expect(
      aggregateBehaviorUnitStatus({
        unit,
        tasks: [
          taskState(makeTask(unit, 1, [fragA]), "extracted", [extractedReceipt(fragA, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])]),
          taskState(makeTask(unit, 2, [fragB]), "no_behavior", [internalReceipt(fragB)]),
        ],
      }),
    ).toBe("extracted");
  });

  it("is no_behavior only when every accountable anchor is reviewed_internal with no retained scenarios", () => {
    const unit = makeUnit([anchor(entryAnchor, "entry"), anchor(anchorA, "behavior"), anchor(anchorB, "implicit_review")]);
    const fragA = fragment(anchorA, 1);
    const fragB = fragment(anchorB, 1);
    // entry 锚点不计入完成分子：没有分片、没有结论，不影响 no_behavior
    expect(
      aggregateBehaviorUnitStatus({
        unit,
        tasks: [
          taskState(makeTask(unit, 1, [fragA]), "no_behavior", [internalReceipt(fragA)]),
          taskState(makeTask(unit, 2, [fragB]), "no_behavior", [internalReceipt(fragB)]),
        ],
      }),
    ).toBe("no_behavior");
  });

  it("never accounts unresolved anchors complete", () => {
    const unit = makeUnit([anchor(anchorA, "behavior"), anchor(anchorB, "implicit_review")]);
    const fragA = fragment(anchorA, 1);
    const fragB = fragment(anchorB, 1);
    expect(
      aggregateBehaviorUnitStatus({
        unit,
        tasks: [
          taskState(makeTask(unit, 1, [fragA]), "extracted", [extractedReceipt(fragA, ["HP-1"])], [feature("订单管理", [scenario("HP-1")])]),
          taskState(makeTask(unit, 2, [fragB]), "unresolved", [unresolvedReceipt(fragB)]),
        ],
      }),
    ).toBe("unresolved");
  });

  it("is unresolved for units without execution tasks (unsplittable units never fake success)", () => {
    const unit = makeUnit([anchor(anchorA, "behavior")]);
    // planner 契约：无法安全拆到预算内的单元不生成任务，交覆盖门禁判 unresolved
    expect(aggregateBehaviorUnitStatus({ unit, tasks: [] })).toBe("unresolved");
  });
});
