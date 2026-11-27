import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindOrganizationModel, type BoundOrganizationModel } from "../lib/organization-model";
import { requestStructuredCompletion, requestStructuredCompletionDetailed, type LlmBillingContext } from "../lib/ai";

// 回执只暴露 INSERT 面：看 SQL 带不带 model_source、参数是多少个。
const receiptCapture = vi.hoisted(() => ({ inserts: [] as Array<{ sql: string; params: unknown[] }> }));
vi.mock("../lib/db", () => ({
  getDb: () => ({
    execute: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("INSERT INTO llm_call_receipts")) {
        receiptCapture.inserts.push({ sql, params: [...params] });
        return [{ insertId: receiptCapture.inserts.length }];
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  }),
  defaultExecute: async () => [[]],
}));

// 只替换出口调的那一个发请求的函数（绑定这些仍是真实的模块）。这样测试不碰网络。
const transport = vi.hoisted(() => ({
  callOrganizationModel: vi.fn<(bound: unknown, outgoing: { headers: Record<string, string>; body: string; timeoutMs?: number }) => Promise<{ status: number; body: string }>>(),
}));
vi.mock("../lib/organization-model", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/organization-model")>()), callOrganizationModel: transport.callOrganizationModel }));

const messages = [{ role: "user", content: "ping" }];
const billing: LlmBillingContext = { runId: 9, accountId: 3, chargeComponent: "main" };
const bound: BoundOrganizationModel = { organizationId: 3, baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi-tenant", model: "k3-256k" };
const okBody = JSON.stringify({ id: "k-1", choices: [{ message: { content: '{"ok":1}' } }], usage: { prompt_tokens: 11, completion_tokens: 4 } });

beforeEach(() => {
  receiptCapture.inserts.length = 0;
  transport.callOrganizationModel.mockReset();
  vi.stubEnv("AI_MODEL", "test-model");
  vi.stubEnv("AI_API_KEY", "server-key");
  vi.stubEnv("AI_BASE_URL", "https://gateway.example");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the server's single exit for model calls", () => {
  it("sends to the workspace's own model with the workspace's key when one is bound, and never touches the server's", async () => {
    const serverFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
      throw new Error("the server's own gateway must not be called");
    });
    vi.stubGlobal("fetch", serverFetch);
    transport.callOrganizationModel.mockResolvedValue({ status: 200, body: okBody });

    const details = await bindOrganizationModel(bound, () => requestStructuredCompletionDetailed(messages, billing));

    expect(details).toEqual({ content: '{"ok":1}', usageRaw: { prompt_tokens: 11, completion_tokens: 4 }, providerRequestId: "k-1", finishReason: null });
    expect(transport.callOrganizationModel).toHaveBeenCalledTimes(1);
    const [target, outgoing] = transport.callOrganizationModel.mock.calls[0];
    // 地址、key 和工作区号一起交给发请求的那一层，由它拼完整地址、做三道地址校验。
    expect(target).toMatchObject({ organizationId: 3, baseUrl: "https://api.kimi.com/coding/v1", apiKey: "sk-kimi-tenant" });
    expect(outgoing).toMatchObject({ headers: { Authorization: "Bearer sk-kimi-tenant", "Content-Type": "application/json" } });
    const sent = JSON.parse(outgoing.body);
    expect(sent).toMatchObject({ model: "k3-256k", messages, max_tokens: 16_000, stream: false });
    // 思考型模型常拒绝 temperature: 0，所以对工作区自己的模型不发它。
    expect("temperature" in sent).toBe(false);
    expect(serverFetch).not.toHaveBeenCalled();
    // 回执记的是实际用的模型，并且写明这次用的是工作区的 key。
    expect(receiptCapture.inserts).toHaveLength(1);
    expect(receiptCapture.inserts[0].sql).toContain("model_source");
    expect(receiptCapture.inserts[0].params).toHaveLength(28);
    expect(receiptCapture.inserts[0].params[3]).toBe("k3-256k");
    expect(receiptCapture.inserts[0].params[27]).toBe("organization");
  });

  it("without a bound workspace sends exactly the request it always sent and records a 27-column receipt", async () => {
    const serverFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(okBody, { status: 200 }));
    vi.stubGlobal("fetch", serverFetch);

    expect(await requestStructuredCompletionDetailed(messages, { ...billing, requestKey: "req-1|describe|1", requestFingerprint: "f".repeat(64) })).toMatchObject({ content: '{"ok":1}', providerRequestId: "k-1" });

    expect(transport.callOrganizationModel).not.toHaveBeenCalled();
    expect(serverFetch).toHaveBeenCalledTimes(1);
    const [url, init] = serverFetch.mock.calls[0];
    expect(url).toBe("https://gateway.example/v1/chat/completions");
    expect(init).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer server-key", "Content-Type": "application/json" },
      // 请求体逐字节不变（包括 temperature: 0）。
      body: `{"model":"test-model","messages":[{"role":"user","content":"ping"}],"temperature":0,"max_tokens":16000,"stream":false}`,
    });
    expect(init?.cache).toBe("no-store");
    expect(receiptCapture.inserts).toHaveLength(1);
    expect(receiptCapture.inserts[0].sql).not.toContain("model_source");
    expect(receiptCapture.inserts[0].params).toHaveLength(27);
    expect(receiptCapture.inserts[0].params[3]).toBe("test-model");
  });

  it("carries the workspace's provider's reason when it refuses, and records the failure against the workspace's model", async () => {
    transport.callOrganizationModel.mockResolvedValue({ status: 400, body: '{"error":{"message":"invalid temperature"}}' });
    const error = await bindOrganizationModel(bound, () => requestStructuredCompletion(messages, billing)).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toBe("the workspace's model provider answered 400: {\"error\":{\"message\":\"invalid temperature\"}}");
    expect(receiptCapture.inserts).toHaveLength(1);
    expect(receiptCapture.inserts[0].params[5]).toBe("failed");
    expect(receiptCapture.inserts[0].params[27]).toBe("organization");
  });

  it("brings the provider's reason back on one line, without the key and no longer than 300 characters, and says so when there is none", async () => {
    // 服务商回显了 key、正文很长还带换行：key 先换成占位符，再并成一行、截短（半截的 key 认不出来，所以先换再截）。
    const echoed = JSON.stringify({ error: { message: `bad key ${bound.apiKey}\n\n${"x".repeat(400)} tail` } });
    const collapsed = echoed.replace(/\s+/g, " ").split(bound.apiKey).join("<key>");
    transport.callOrganizationModel.mockResolvedValueOnce({ status: 401, body: echoed });
    const error = await bindOrganizationModel(bound, () => requestStructuredCompletion(messages, billing)).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    // 截到 300 个字符：正好停在那一串 x 里，后面的 tail 不见了。
    expect(error?.message).toBe(`the workspace's model provider answered 401: ${collapsed.slice(0, 300)}`);
    expect(error?.message.endsWith("x")).toBe(true);
    expect(error?.message).not.toContain(bound.apiKey);
    transport.callOrganizationModel.mockResolvedValueOnce({ status: 502, body: "" });
    await expect(bindOrganizationModel(bound, () => requestStructuredCompletion(messages, billing))).rejects.toThrow("the workspace's model provider answered 502");
  });

  it("records a timeout as a timeout and a transport failure as a failure", async () => {
    transport.callOrganizationModel.mockRejectedValueOnce(Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" }));
    await expect(bindOrganizationModel(bound, () => requestStructuredCompletion(messages, billing))).rejects.toThrow(/timeout/);
    transport.callOrganizationModel.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    await expect(bindOrganizationModel(bound, () => requestStructuredCompletion(messages, billing))).rejects.toThrow("ECONNREFUSED");
    expect(receiptCapture.inserts.map((insert) => insert.params[5])).toEqual(["timeout", "failed"]);
  });

  it("does not stay bound once the work is over", async () => {
    transport.callOrganizationModel.mockResolvedValue({ status: 200, body: okBody });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(okBody, { status: 200 })));
    await bindOrganizationModel(bound, async () => requestStructuredCompletion(messages, billing));
    await requestStructuredCompletion(messages, billing);
    expect(transport.callOrganizationModel).toHaveBeenCalledTimes(1);
  });
});
