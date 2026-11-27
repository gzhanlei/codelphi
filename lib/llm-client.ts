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

export interface CompletionUsageMetadata {
  requestId: string | null;
  durationMs: number;
}

export type CompletionUsageHandler = (usage: unknown, metadata: CompletionUsageMetadata) => void | Promise<void>;

export interface OpenAICompatibleClientOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onUsage?: CompletionUsageHandler;
}

/** 把配置的地址拼成 chat-completions 的完整地址。客户端和服务端用同一条规则。 */
export function completionsUrl(baseUrl: string | undefined) {
  const configured = (baseUrl || "http://127.0.0.1:4000").replace(/\/$/, "");
  if (configured.endsWith("/v1/chat/completions")) return configured;
  if (configured.endsWith("/v1")) return `${configured}/chat/completions`;
  return `${configured}/v1/chat/completions`;
}

/**
 * 服务商拒绝时的原因。只带状态码没法排查（400 可能是模型名、参数、权限里的任何一个），
 * 所以把应答正文并成一行、截短后带上。正文是服务商写的，不会含 key；万一回显了，换成占位符。
 * 先换占位符再截短：截短会把 key 截成半截，半截的 key 就认不出来了。
 */
async function refusalDetail(response: Response, apiKey: string): Promise<string> {
  const text = await response.text().catch(() => "");
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine === "") return "";
  return `: ${oneLine.split(apiKey).join("<key>").slice(0, 300)}`;
}

/**
 * Standalone OpenAI-compatible transport. Host adapters never need this configuration.
 * 只在客户端用（雷达快照的 standalone 模式、客户端分析的发布）；托管分析走 lib/ai.ts 自己的请求。
 */
export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions): StructuredCompletionClient {
  const request = options.fetchImpl ?? fetch;
  return {
    displayName: options.model,
    async complete(messages) {
      const startedAt = Date.now();
      const response = await request(completionsUrl(options.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        // 不发 temperature，用服务商自己的默认值。思考型模型有的只接受某一个固定值，有的不接受 0；
        // 写死任何一个都会被其中一家拒绝（2026-11-27 Kimi 的 coding 接口对 temperature: 0 回 400）。
        body: JSON.stringify({ model: options.model, messages, max_tokens: 16_000, stream: false }),
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!response.ok) throw new Error(`AI gateway returned HTTP ${response.status}${await refusalDetail(response, options.apiKey)}`);
      const payload = await response.json() as { id?: string; choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("AI gateway returned empty content");
      await options.onUsage?.(payload.usage ?? null, { requestId: payload.id ?? null, durationMs: Date.now() - startedAt });
      return content;
    },
  };
}

export function createStandaloneClientFromEnv(environment: Record<string, string | undefined>, options: Pick<OpenAICompatibleClientOptions, "onUsage" | "fetchImpl"> = {}): StructuredCompletionClient {
  const missing = ["AI_API_KEY", "AI_MODEL"].filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new SnapshotLlmConfigurationError("missing_ai_config", `Missing standalone AI configuration: ${missing.join(", ")}`);
  }
  return createOpenAICompatibleClient({
    baseUrl: environment.AI_BASE_URL,
    apiKey: environment.AI_API_KEY!,
    model: environment.AI_MODEL!,
    timeoutMs: Number(environment.AI_TIMEOUT_MS) || 180_000,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
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
