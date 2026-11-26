import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SpecFeature } from "../lib/spec-diff";
import type { StructuredCompletionClient } from "../lib/llm-client";

const receipts = vi.hoisted(() => ({ record: vi.fn(async () => undefined) }));
vi.mock("../lib/billing/cost-receipt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/billing/cost-receipt")>();
  return { ...actual, recordLlmCallReceipt: receipts.record, recordRequestScopedReceipt: vi.fn(async () => undefined) };
});

import { analyzeBehavioralGroup, buildAnalysisMessages } from "../lib/ai";
import { enumerateBehavioralChunks } from "../lib/behavioral-enumeration";
import { generateFeatureFlowGraph } from "../lib/feature-flow-generation";
import { CLIENT_PROMPT_VERSION, noSourceOutputRule } from "../lib/prompt-policy";

const feature: SpecFeature = {
  name: "登录",
  summary: "登录",
  scenarios: [
    { reference: "HP-1", context: "已构建", action: "预热", outcome: "缓存就绪", category: "happy", source: "generated", evidence: [], step: null },
    { reference: "HP-2", context: "缓存就绪", action: "执行测量", outcome: "完成", category: "happy", source: "generated", evidence: [], step: null },
  ],
};
const graph = {
  entryNodeIds: ["start"],
  nodes: [
    { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
    { id: "warmup", kind: "action", title: "预热", scenarioRefs: ["HP-1"] },
    { id: "measure", kind: "action", title: "执行测量", scenarioRefs: ["HP-2"] },
  ],
  edges: [
    { id: "e1", from: "start", to: "warmup", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e2", from: "warmup", to: "measure", kind: "sequence", scenarioRefs: ["HP-2"] },
  ],
  excludedScenarios: [],
};
const targets = [{ path: "lib/a.ts", patch: "@@ -1,2 +1,3 @@\n-old\n+new\n+more", contextBlocks: [{ startLine: 1, endLine: 3, content: "1: new\n2: more\n3: tail" }] }];
const change = { message: "feat", files: [] };

function fakeClient(answers: string[]): StructuredCompletionClient & { calls: Array<Array<{ role: string; content: string }>> } {
  const calls: Array<Array<{ role: string; content: string }>> = [];
  let index = 0;
  return {
    calls,
    displayName: "tenant-model",
    async complete(messages) {
      calls.push(messages);
      return answers[Math.min(index++, answers.length - 1)];
    },
  };
}

const network = vi.fn();
beforeEach(() => {
  network.mockReset();
  vi.stubGlobal("fetch", network);
});
afterEach(() => vi.unstubAllGlobals());

describe("model calls with a client-injected model", () => {
  it("runs the two behavioural steps on the injected client and never touches the network", async () => {
    const client = fakeClient([
      JSON.stringify({ files: [{ path: "lib/a.ts", changes: [{ hunk: "@@ -1,2 +1,3 @@", before: "旧的", after: "新的" }] }] }),
      JSON.stringify({ features: [] }),
    ]);
    await analyzeBehavioralGroup(targets, [], change, undefined, "zh-CN", { client });
    expect(client.calls).toHaveLength(2);
    expect(network).not.toHaveBeenCalled();
  });

  it("still goes to the network when no client is injected, exactly as before", async () => {
    vi.stubEnv("AI_API_KEY", "test-key");
    vi.stubEnv("AI_MODEL", "test-model");
    // 每次调用要一个新的 Response：响应体只能读一次。
    network.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ files: [] }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await analyzeBehavioralGroup(targets, [], change);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("generates a flow graph on the injected client", async () => {
    const client = fakeClient([JSON.stringify(graph)]);
    const result = await generateFeatureFlowGraph(feature, undefined, "zh-CN", { client });
    expect(result.entryNodeIds).toEqual(["start"]);
    expect(client.calls).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });

  it("asks the injected client again when the first graph fails validation", async () => {
    const client = fakeClient([JSON.stringify({ ...graph, edges: [] }), JSON.stringify(graph)]);
    const result = await generateFeatureFlowGraph(feature, undefined, "zh-CN", { client });
    expect(result.edges).toHaveLength(2);
    expect(client.calls).toHaveLength(2);
    // 纠错那一次带着原来的两条消息、模型的上一版输出和一条新的用户消息。
    expect(client.calls[1].slice(0, 2)).toEqual(client.calls[0]);
    expect(client.calls[1].slice(2).map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(network).not.toHaveBeenCalled();
  });

  it("enumerates behavioural files without a billing context when the client supplies the model", async () => {
    const client = fakeClient([
      JSON.stringify({ files: [{ path: "lib/a.ts", changes: [{ hunk: "@@ -1,2 +1,3 @@", before: "旧", after: "新" }] }] }),
      JSON.stringify({ features: [{ name: "登录", summary: "登录", scenarios: [{ reference: "HP-1", context: "c", action: "a", outcome: "o", category: "happy", evidence: [{ path: "lib/a.ts", startLine: 1 }] }] }] }),
    ]);
    const files = [{ path: "lib/a.ts", status: "modified", patch: targets[0].patch }];
    const outcome = await enumerateBehavioralChunks({
      behavioralPaths: ["lib/a.ts"],
      files,
      index: { readLines: vi.fn(async () => ({ startLine: 1, endLine: 3, lineCount: 3, lines: ["new", "more", "tail"] })) } as never,
      change: { message: "feat", files },
      knownFeatureNames: [],
      client,
    });
    expect(outcome.chunks).toHaveLength(1);
    expect(outcome.metrics.status).toBe("complete");
    expect(client.calls).toHaveLength(2);
    expect(network).not.toHaveBeenCalled();
  });

  it("does not make the enumeration module depend on the analysis entry module any more", () => {
    // 客户端打包时这个循环把数据库和分析入口拖进了单文件；sanitizeEvidence 实际定义在 extraction-pass。
    const source = readFileSync(new URL("../lib/behavioral-enumeration.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from "\.\/analysis"/);
    expect(source).toMatch(/import \{ sanitizeEvidence \} from "\.\/extraction-pass"/);
  });
});

describe("the no-source-output rule", () => {
  it("is only added when asked for, so hosted prompts stay byte for byte what they were", () => {
    const sources = [{ path: "lib/a.ts", content: "1: const a = 1;", ...{} }] as unknown as Parameters<typeof buildAnalysisMessages>[0];
    const hosted = buildAnalysisMessages(sources, change, {});
    const again = buildAnalysisMessages(sources, change, {});
    expect(again).toEqual(hosted);
    const client = buildAnalysisMessages(sources, change, { noSourceOutput: true });
    expect(client[1].content).toBe(`${hosted[1].content}\n${noSourceOutputRule("zh-CN")}`);
    expect(client[0]).toEqual(hosted[0]);
  });

  it("reaches every prompt the client sends: extraction, both behavioural steps, the flow graph and its correction", async () => {
    const flowClient = fakeClient([JSON.stringify({ ...graph, edges: [] }), JSON.stringify(graph)]);
    await generateFeatureFlowGraph(feature, undefined, "en", { client: flowClient, noSourceOutput: true });
    expect(flowClient.calls.every((messages) => messages.some((message) => (message.content as string).includes(noSourceOutputRule("en"))))).toBe(true);

    const behavioralClient = fakeClient([
      JSON.stringify({ files: [{ path: "lib/a.ts", changes: [{ hunk: "@@ -1,2 +1,3 @@", before: "old", after: "new" }] }] }),
      JSON.stringify({ features: [] }),
    ]);
    await analyzeBehavioralGroup(targets, [], change, undefined, "en", { client: behavioralClient, noSourceOutput: true });
    expect(behavioralClient.calls).toHaveLength(2);
    expect(behavioralClient.calls.every((messages) => (messages[1].content as string).endsWith(noSourceOutputRule("en")))).toBe(true);
  });

  it("says what is forbidden, what identifiers are for, and names no source", () => {
    for (const language of ["zh-CN", "en"] as const) {
      const rule = noSourceOutputRule(language);
      expect(rule.length).toBeGreaterThan(60);
      expect(rule).not.toMatch(/[{}=;]/);
    }
    expect(CLIENT_PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });
});
