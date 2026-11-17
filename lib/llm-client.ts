export interface StructuredCompletionMessage {
  role: string;
  content: string;
}

/**
 * Host-neutral structured completion boundary. The caller owns model selection and
 * credentials; extraction code only supplies messages and parses the response.
 */
export interface StructuredCompletionClient {
  complete(messages: StructuredCompletionMessage[]): Promise<string>;
  /** Optional host-approved display name for report metadata. */
  displayName?: string;
}

export class SnapshotLlmConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotLlmConfigurationError";
  }
}

export interface OpenAICompatibleClientOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function completionsUrl(baseUrl: string | undefined) {
  const configured = (baseUrl || "http://127.0.0.1:4000").replace(/\/$/, "");
  if (configured.endsWith("/v1/chat/completions")) return configured;
  if (configured.endsWith("/v1")) return `${configured}/chat/completions`;
  return `${configured}/v1/chat/completions`;
}

/** Standalone OpenAI-compatible transport. Host adapters never need this configuration. */
export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions): StructuredCompletionClient {
  const request = options.fetchImpl ?? fetch;
  return {
    displayName: options.model,
    async complete(messages) {
      const response = await request(completionsUrl(options.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: options.model, messages, temperature: 0, max_tokens: 16_000, stream: false }),
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!response.ok) throw new Error(`AI gateway returned HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("AI gateway returned empty content");
      return content;
    },
  };
}

export function createStandaloneClientFromEnv(environment: Record<string, string | undefined>): StructuredCompletionClient {
  const missing = ["AI_API_KEY", "AI_MODEL"].filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new SnapshotLlmConfigurationError("missing_ai_config", `Missing standalone AI configuration: ${missing.join(", ")}`);
  }
  return createOpenAICompatibleClient({
    baseUrl: environment.AI_BASE_URL,
    apiKey: environment.AI_API_KEY!,
    model: environment.AI_MODEL!,
  });
}

export function standaloneGatewayHost(environment: Record<string, string | undefined>) {
  const configured = environment.AI_BASE_URL || "http://127.0.0.1:4000";
  try {
    return new URL(configured).host;
  } catch {
    return "configured gateway";
  }
}

export interface HostBridgeClientOptions {
  endpoint: string;
  headers?: Record<string, string>;
  displayName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Host-owned completion bridge. The host, not this request, selects the active model. */
export function createHostBridgeClient(options: HostBridgeClientOptions): StructuredCompletionClient {
  const request = options.fetchImpl ?? fetch;
  return {
    displayName: options.displayName ?? "Host current model",
    async complete(messages) {
      const response = await request(options.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: JSON.stringify({ messages }),
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!response.ok) throw new Error(`Host AI bridge returned HTTP ${response.status}`);
      const payload = await response.json() as { content?: string; choices?: Array<{ message?: { content?: string } }> };
      const content = payload.content ?? payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("Host AI bridge returned empty content");
      return content;
    },
  };
}
