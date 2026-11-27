import { describe, expect, it } from "vitest";
import { createOpenAICompatibleClient, createStandaloneClientFromEnv } from "../lib/llm-client";

function gateway(status: number, body: unknown = { choices: [{ message: { content: '{"ok":true}' } }] }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const message = [{ role: "user" as const, content: "hi" }];

describe("the standalone model client", () => {
  it("sends the model, the messages and room for a long answer, and no temperature", async () => {
    const { calls, fetchImpl } = gateway(200);
    await createOpenAICompatibleClient({ baseUrl: "https://api.example/v1", apiKey: "sk_x", model: "m", fetchImpl }).complete(message);
    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ model: "m", messages: message, max_tokens: 16_000, stream: false });
    // temperature 不发：用服务商自己的默认值。思考型模型有的只接受固定的值，有的不接受 0，写死哪个都会被拒。
    expect("temperature" in sent).toBe(false);
    expect(calls[0].init.headers).toMatchObject({ Authorization: "Bearer sk_x", "Content-Type": "application/json" });
  });

  it("joins the chat-completions path to whatever form of address was configured", async () => {
    for (const [baseUrl, expected] of [
      ["https://api.kimi.com/coding/v1", "https://api.kimi.com/coding/v1/chat/completions"],
      ["https://api.example/v1/", "https://api.example/v1/chat/completions"],
      ["https://api.example", "https://api.example/v1/chat/completions"],
      ["https://api.example/v1/chat/completions", "https://api.example/v1/chat/completions"],
      [undefined, "http://127.0.0.1:4000/v1/chat/completions"],
    ] as const) {
      const { calls, fetchImpl } = gateway(200);
      await createOpenAICompatibleClient({ baseUrl, apiKey: "sk_x", model: "m", fetchImpl }).complete(message);
      expect(calls[0].url).toBe(expected);
    }
  });

  it("says why the provider refused instead of only the status code", async () => {
    const { fetchImpl } = gateway(400, { error: { message: "Invalid temperature: must be in (0, 1]\n  for this model", type: "invalid_request_error" } });
    await expect(createOpenAICompatibleClient({ baseUrl: "https://api.example/v1", apiKey: "sk_x", model: "m", fetchImpl }).complete(message)).rejects.toThrow(
    // 应答正文是 JSON 时，正文里字符串内的换行是转义过的两个字符（反斜杠、n），原样保留；真正的空白才并成空格。
    /^AI gateway returned HTTP 400: \{"error":\{"message":"Invalid temperature: must be in \(0, 1\]\\n for this model","type":"invalid_request_error"\}\}$/,
    );
  });

  it("keeps the provider's reason short, on one line, and never repeats the key in it", async () => {
    const long = "x".repeat(2_000);
    const { fetchImpl } = gateway(429, `{"error":"quota exhausted for key sk_x, ${long}"}`);
    const error = await createOpenAICompatibleClient({ baseUrl: "https://api.example/v1", apiKey: "sk_x", model: "m", fetchImpl }).complete(message).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).not.toBeNull();
    expect(error!.message.startsWith("AI gateway returned HTTP 429: ")).toBe(true);
    expect(error!.message.length).toBeLessThan("AI gateway returned HTTP 429: ".length + 301);
    expect(error!.message).not.toContain("sk_x");
    expect(error!.message).toContain("<key>");
    // 多行的原因并成一行，不往终端里灌一段 JSON。
    const { fetchImpl: multiline } = gateway(403, "{\n  \"error\": \"plan does not include k3\",\n  \"request_id\": \"r1\"\n}");
    await expect(createOpenAICompatibleClient({ baseUrl: "https://api.example/v1", apiKey: "sk_x", model: "m", fetchImpl: multiline }).complete(message)).rejects.toThrow("AI gateway returned HTTP 403: { \"error\": \"plan does not include k3\", \"request_id\": \"r1\" }");
  });

  it("reports the status alone when the provider says nothing, and an empty answer as such", async () => {
    const { fetchImpl } = gateway(502, "");
    await expect(createOpenAICompatibleClient({ baseUrl: "https://api.example/v1", apiKey: "sk_x", model: "m", fetchImpl }).complete(message)).rejects.toThrow(/^AI gateway returned HTTP 502$/);
    const { fetchImpl: empty } = gateway(200, { choices: [{ message: { content: "" } }] });
    await expect(createOpenAICompatibleClient({ baseUrl: "https://api.example/v1", apiKey: "sk_x", model: "m", fetchImpl: empty }).complete(message)).rejects.toThrow("AI gateway returned empty content");
  });

  it("returns the answer's content and names the model", async () => {
    const { fetchImpl } = gateway(200);
    const client = createOpenAICompatibleClient({ baseUrl: "https://api.example/v1", apiKey: "sk_x", model: "k3-256k", fetchImpl });
    expect(await client.complete(message)).toBe('{"ok":true}');
    expect(client.displayName).toBe("k3-256k");
    // 从配置建出来的客户端也走同一条请求。
    const second = gateway(200);
    await createStandaloneClientFromEnv({ AI_BASE_URL: "https://api.example/v1", AI_API_KEY: "sk_y", AI_MODEL: "k3-256k" }, { fetchImpl: second.fetchImpl } as never).complete(message);
    expect(JSON.parse(String(second.calls[0].init.body))).toMatchObject({ model: "k3-256k" });
    expect("temperature" in (JSON.parse(String(second.calls[0].init.body)) as object)).toBe(false);
  });
});
