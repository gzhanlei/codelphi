import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AiOutputTruncatedError,
  chatCompletionsUrl,
  gatewayResponse,
  requestStructuredCompletion,
  requestStructuredCompletionDetailed,
  type LlmBillingContext,
} from "../lib/ai";

// 回执捕获（recordRequestScopedReceipt/recordLlmCallReceipt 经 getDb）：只暴露 INSERT 面。
const receiptCapture = vi.hoisted(() => {
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  return { inserts };
});
vi.mock("../lib/db", () => ({
  getDb: () => ({
    execute: async (sql: string, params: Array<string | number | null>) => {
      if (sql.startsWith("INSERT INTO llm_call_receipts")) {
        receiptCapture.inserts.push({ sql, params: [...params] });
        return [{ insertId: receiptCapture.inserts.length }];
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  }),
}));

describe("AI gateway compatibility", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("accepts root, versioned and full endpoint URLs", () => {
    vi.stubEnv("AI_BASE_URL", "https://gateway.example/");
    expect(chatCompletionsUrl()).toBe("https://gateway.example/v1/chat/completions");
    vi.stubEnv("AI_BASE_URL", "https://gateway.example/v1");
    expect(chatCompletionsUrl()).toBe("https://gateway.example/v1/chat/completions");
    vi.stubEnv("AI_BASE_URL", "https://gateway.example/v1/chat/completions");
    expect(chatCompletionsUrl()).toBe("https://gateway.example/v1/chat/completions");
    vi.stubEnv("AI_BASE_URL", "");
    expect(chatCompletionsUrl()).toBe("http://127.0.0.1:4000/v1/chat/completions");
  });

  it("extracts content, usage and request id from a gateway response", () => {
    const response = gatewayResponse({
      id: "chatcmpl-1",
      choices: [{ message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    expect(response.content).toBe("{\"ok\":true}");
    expect(response.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(response.requestId).toBe("chatcmpl-1");
  });

  it("normalizes numeric gateway ids and missing usage", () => {
    const response = gatewayResponse({ id: 42, choices: [{ message: { content: "ok" } }] });
    expect(response.requestId).toBe("42");
    expect(response.usage).toBeNull();
  });

  it("fails clearly for an empty gateway response", () => {
    expect(() => gatewayResponse({ choices: [] })).toThrow("AI gateway returned empty content");
    expect(() => gatewayResponse({ choices: [{}] })).toThrow("AI gateway returned empty content");
    expect(() => gatewayResponse(null)).toThrow();
  });

  it("exposes finish_reason so a truncated output can be detected before JSON parsing", () => {
    expect(gatewayResponse({ choices: [{ message: { content: "{\"ok\":true}" } }] }).finishReason).toBeNull();
    expect(gatewayResponse({ choices: [{ message: { content: "partial" }, finish_reason: "stop" }] }).finishReason).toBe("stop");
    expect(gatewayResponse({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }).finishReason).toBe("length");
    expect(AiOutputTruncatedError.isInstance(new AiOutputTruncatedError())).toBe(true);
    expect(AiOutputTruncatedError.isInstance(new Error("AI output truncated (finish_reason=length)"))).toBe(true);
  });
});

describe("structured completion request identity (Task 4)", () => {
  const messages = [{ role: "user", content: "ping" }];
  const billing: LlmBillingContext = {
    runId: 9,
    accountId: 3,
    chargeComponent: "main",
    callStage: "describe",
    requestKey: "req-1|describe|1",
    requestFingerprint: "f".repeat(64),
  };
  const okPayload = {
    id: "gw-1",
    choices: [{ message: { content: "{\"ok\":1}" } }],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
  };

  beforeEach(() => {
    receiptCapture.inserts.length = 0;
    vi.stubEnv("AI_MODEL", "test-model");
    vi.stubEnv("AI_API_KEY", "key-1");
    vi.stubEnv("AI_BASE_URL", "https://gateway.example");
  });

  it("returns full details without throwing on finish_reason=length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...okPayload, choices: [{ message: { content: "partial" }, finish_reason: "length" }] }), {
          status: 200,
        }),
      ),
    );
    const details = await requestStructuredCompletionDetailed(messages, billing);
    expect(details).toEqual({
      content: "partial",
      usageRaw: { prompt_tokens: 11, completion_tokens: 4 },
      providerRequestId: "gw-1",
      finishReason: "length",
    });
    // 截断照记 usage 回执并携带请求身份（成本已发生，原始响应由 batch 侧持久化）
    expect(receiptCapture.inserts).toHaveLength(1);
    const params = receiptCapture.inserts[0]!.params;
    expect(params[5]).toBe("failed");
    expect(params[6]).toBe("known");
    expect(params[24]).toBe("req-1|describe|1");
    expect(params[25]).toBe("f".repeat(64));
    expect(typeof params[26]).toBe("number");
  });

  it("legacy requestStructuredCompletion keeps returning content and throwing on length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(okPayload), { status: 200 })));
    await expect(requestStructuredCompletion(messages, billing)).resolves.toBe("{\"ok\":1}");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ...okPayload, choices: [{ message: { content: "partial" }, finish_reason: "length" }] }), {
          status: 200,
        }),
      ),
    );
    const error = await requestStructuredCompletion(messages, billing).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(AiOutputTruncatedError.isInstance(error)).toBe(true);
  });

  it("records request-scoped unknown receipts immediately on network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await expect(requestStructuredCompletionDetailed(messages, billing)).rejects.toThrow("boom");
    expect(receiptCapture.inserts).toHaveLength(1);
    const params = receiptCapture.inserts[0]!.params;
    expect(params[5]).toBe("failed");
    expect(params[6]).toBe("unknown");
    expect(params[24]).toBe("req-1|describe|1");
  });
});
