import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletionsUrl, gatewayResponse } from "../lib/ai";

describe("AI gateway compatibility", () => {
  afterEach(() => vi.unstubAllEnvs());

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
});
