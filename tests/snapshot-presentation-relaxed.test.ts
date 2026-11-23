import { describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../lib/ai";
import type { StructuredCompletionMessage } from "../lib/llm-client";
import { createSnapshotPresentation, journeyMiningPrompt, parseSnapshotPresentation, parseSnapshotPresentationRelaxed } from "../lib/snapshot/presentation";

/**
 * Radar 归组的 relax 模式（站内理解层用）。生产实测（2026-11-24，ds-flash）：模型给每个能力
 * 返回 4–6 条示例引用、或某条旅程没连够两个功能——严格模式会让整份归组作废。relax 逐条 salvage，
 * 只保「每个功能恰好归属一次」这条硬约束（它是总览「AI 归纳 · 已校验」标注的依据）。
 * Radar 报告自身的严格行为不变。
 */

const result: AnalysisResult = {
  product: { description: "A product for teams", evidence: [{ path: "src/index.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [],
  features: [
    { name: "Sign in", summary: "OAuth sign in", scenarios: [
      { reference: "HP-1", context: "A visitor", action: "Signs in", outcome: "Sees the dashboard", category: "happy", evidence: [{ path: "src/auth.ts", startLine: 1 }] },
      { reference: "HP-2", context: "A member", action: "Signs out", outcome: "Back to the login page", category: "happy", evidence: [{ path: "src/auth.ts", startLine: 9 }] },
      { reference: "ER-1", context: "Bad credentials", action: "Signs in", outcome: "Rejected", category: "error", evidence: [{ path: "src/auth.ts", startLine: 20 }] },
    ] },
    { name: "Projects", summary: "Group work into projects", scenarios: [{ reference: "HP-1", context: "A member", action: "Creates a project", outcome: "Project listed", category: "happy", evidence: [{ path: "src/projects.ts", startLine: 1 }] }] },
    { name: "Tasks", summary: "Track tasks", scenarios: [{ reference: "HP-1", context: "A member", action: "Adds a task", outcome: "Task listed", category: "happy", evidence: [{ path: "src/tasks.ts", startLine: 1 }] }] },
    { name: "Reports", summary: "Summarize progress", scenarios: [{ reference: "HP-1", context: "A manager", action: "Opens reports", outcome: "Sees progress", category: "happy", evidence: [{ path: "src/reports.ts", startLine: 1 }] }] },
  ],
};

const four = ["Sign in", "Projects", "Tasks", "Reports"];

/** 生产实测形态：每个能力带 4–6 条示例引用。 */
const manyRefs = JSON.stringify({
  tagline: "Plan and track work with your team.",
  coreCapabilities: [
    { name: "Access", summary: "Sign in and out.", featureNames: ["Sign in"], scenarioRefs: [{ featureName: "Sign in", reference: "HP-1" }, { featureName: "Sign in", reference: "HP-2" }, { featureName: "Sign in", reference: "ER-1" }] },
    { name: "Plan work", summary: "Projects, tasks and reports.", featureNames: ["Projects", "Tasks", "Reports"], scenarioRefs: four.map((featureName) => ({ featureName, reference: "HP-1" })) },
  ],
  journeys: [],
  concepts: [],
});

describe("snapshot presentation relax mode", () => {
  it("keeps the strict default: more than two example references reject the whole presentation", () => {
    expect(() => parseSnapshotPresentation(manyRefs, result)).toThrow(/<=2 items/);
  });

  it("clamps over-long example references instead of rejecting the grouping", () => {
    const relaxed = parseSnapshotPresentationRelaxed(manyRefs, result);
    expect(relaxed.status).toBe("generated");
    expect(relaxed.coreCapabilities.map((capability) => capability.scenarioRefs.length)).toEqual([2, 2]);
    expect(relaxed.tagline).toBe("Plan and track work with your team.");
  });

  it("drops journeys one by one when they are not cross-feature happy paths", () => {
    const content = JSON.stringify({
      tagline: "t",
      coreCapabilities: [{ name: "Everything", summary: "s", featureNames: four, scenarioRefs: [] }],
      journeys: [
        { name: "只连了一个功能", steps: [{ featureName: "Sign in", reference: "HP-1" }, { featureName: "Sign in", reference: "HP-2" }] },
        { name: "引用了错误场景", steps: [{ featureName: "Sign in", reference: "ER-1" }, { featureName: "Tasks", reference: "HP-1" }] },
        { name: "引用了不存在的场景", steps: [{ featureName: "Sign in", reference: "HP-1" }, { featureName: "Tasks", reference: "HP-9" }] },
        { name: "只有一步", steps: [{ featureName: "Sign in", reference: "HP-1" }] },
        { name: "Plan and report", steps: [{ featureName: "Sign in", reference: "HP-1" }, { featureName: "Tasks", reference: "HP-1" }, { featureName: "Reports", reference: "HP-1" }] },
      ],
      concepts: [],
    });
    expect(() => parseSnapshotPresentation(content, result)).toThrow();
    const relaxed = parseSnapshotPresentationRelaxed(content, result);
    expect(relaxed.journeys.map((journey) => [journey.id, journey.name])).toEqual([["journey-1", "Plan and report"]]);
    expect(relaxed.journeys[0].evidenceStatus).toBe("scenario_composition");
  });

  it("drops example references that do not belong to the capability or do not exist", () => {
    const content = JSON.stringify({
      tagline: "t",
      coreCapabilities: [
        { name: "Access", summary: "s", featureNames: ["Sign in"], scenarioRefs: [{ featureName: "Tasks", reference: "HP-1" }, { featureName: "Sign in", reference: "HP-9" }, { featureName: "Sign in", reference: "HP-1" }] },
        { name: "Plan work", summary: "s", featureNames: ["Projects", "Tasks", "Reports"], scenarioRefs: [] },
      ],
      journeys: [], concepts: [],
    });
    // 严格模式：三条示例引用先撞上数量上限；relax 只留下确实属于本能力且存在的那一条
    expect(() => parseSnapshotPresentation(content, result)).toThrow();
    expect(parseSnapshotPresentationRelaxed(content, result).coreCapabilities[0].scenarioRefs).toEqual([{ featureName: "Sign in", reference: "HP-1" }]);
  });

  it("keeps the one hard guarantee strict: every feature belongs to exactly one capability", () => {
    const missing = JSON.stringify({ tagline: "t", coreCapabilities: [{ name: "Some", summary: "s", featureNames: ["Sign in", "Tasks"], scenarioRefs: [] }], journeys: [], concepts: [] });
    expect(() => parseSnapshotPresentationRelaxed(missing, result)).toThrow(/must cover every existing feature/);
    const unknown = JSON.stringify({ tagline: "t", coreCapabilities: [{ name: "Some", summary: "s", featureNames: [...four, "Made up"], scenarioRefs: [] }], journeys: [], concepts: [] });
    expect(() => parseSnapshotPresentationRelaxed(unknown, result)).toThrow(/Invalid feature coverage/);
    const duplicated = JSON.stringify({ tagline: "t", coreCapabilities: [
      { name: "A", summary: "s", featureNames: ["Sign in", "Projects", "Tasks"], scenarioRefs: [] },
      { name: "B", summary: "s", featureNames: ["Reports", "Tasks"], scenarioRefs: [] },
    ], journeys: [], concepts: [] });
    expect(() => parseSnapshotPresentationRelaxed(duplicated, result)).toThrow(/Invalid feature coverage/);
  });

  it("is opt-in on the generator: the default path still rejects, relax salvages", async () => {
    const complete = vi.fn(async (_messages: StructuredCompletionMessage[]) => manyRefs);
    await expect(createSnapshotPresentation({ result, language: "en", client: { complete } })).rejects.toThrow(/<=2 items/);
    const relaxed = await createSnapshotPresentation({ result, language: "en", client: { complete }, relax: true });
    expect(relaxed.coreCapabilities).toHaveLength(2);
  });
});

describe("journey mining prompt layout", () => {
  it("puts the JSON-only instruction with the exact shape immediately before the data", () => {
    const prompt = journeyMiningPrompt({ productDescription: "简介", capabilityName: "计划与跟踪", maxJourneys: 6, candidates: [{ featureName: "任务", reference: "HP-1", context: "c", action: "a", outcome: "o" }] }, "zh-CN");
    const shapeAt = prompt.indexOf('结构为：{"journeys":[');
    // 结构要求在全部说明之后、数据之前：生产实测埋在中间时模型会改成输出 Markdown
    expect(shapeAt).toBeGreaterThan(prompt.indexOf("最多返回 6 条旅程"));
    expect(shapeAt).toBeGreaterThan(prompt.indexOf("所属能力：计划与跟踪"));
    expect(shapeAt).toBeLessThan(prompt.indexOf("产品简介："));
    expect(prompt).toContain("不要 Markdown");
    // 生产实测：模型会把同一功能的两三个场景首尾相接当成旅程；提示词明确禁止相邻两步同功能
    expect(prompt).toContain("相邻两步不要取自同一个功能");
    const english = journeyMiningPrompt({ productDescription: "d", capabilityName: null, maxJourneys: 5, candidates: [] }, "en");
    expect(english.indexOf("with this shape:")).toBeLessThan(english.indexOf("Product description:"));
    expect(english.indexOf("with this shape:")).toBeGreaterThan(english.indexOf("Return at most 5 journeys"));
  });
});
