import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletionsUrl, gatewayContent } from "../lib/ai";

describe("AI gateway compatibility", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts root, versioned and full endpoint URLs", () => {
    vi.stubEnv("AI_BASE_URL", "https://gateway.example/");
    expect(chatCompletionsUrl()).toBe("https://gateway.example/v1/chat/completions");
    vi.stubEnv("AI_BASE_URL", "https://gateway.example/v1");
    expect(chatCompletionsUrl()).toBe("https://gateway.example/v1/chat/completions");
    vi.stubEnv("AI_BASE_URL", "https://gateway.example/v1/chat/completions");
    expect(chatCompletionsUrl()).toBe("https://gateway.example/v1/chat/completions");
  });

  it("extracts content and fails clearly for an empty gateway response", () => {
    expect(gatewayContent({ choices: [{ message: { content: "{\"ok\":true}" } }] })).toBe("{\"ok\":true}");
    expect(() => gatewayContent({ choices: [] })).toThrow("AI gateway returned empty content");
    expect(() => gatewayContent(null)).toThrow();
  });
});
