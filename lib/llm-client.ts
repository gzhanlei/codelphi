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
  /** 这个客户端让不让模型先思考。不发 thinking 参数的客户端不带这一项。 */
  thinking?: ThinkingMode;
}

export class SnapshotLlmConfigurationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotLlmConfigurationError";
  }
}

export class AiOutputTruncatedError extends Error {
  constructor() {
    super("AI output truncated (finish_reason=length): raise the model output budget or narrow the analysis scope");
    this.name = "AiOutputTruncatedError";
  }
  static isInstance(error: unknown): boolean {
    return error instanceof AiOutputTruncatedError || /AI output truncated \(finish_reason=length\)/.test(error instanceof Error ? error.message : String(error));
  }
}

export interface CompletionUsageMetadata {
  requestId: string | null;
  durationMs: number;
}

export type CompletionUsageHandler = (usage: unknown, metadata: CompletionUsageMetadata) => void | Promise<void>;

/** 要不要让模型先思考再回答。不发这个参数时由服务商决定。 */
export type ThinkingMode = "enabled" | "disabled";

export interface OpenAICompatibleClientOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxTokens?: number;
  /** 发 `thinking: {type}`。不填就不发。 */
  thinking?: ThinkingMode;
  onUsage?: CompletionUsageHandler;
}

/** DeepSeek 的官方接口。只有它在请求里不带 thinking 时默认开启思考。 */
export function isDeepSeekApi(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).host.toLowerCase() === "api.deepseek.com";
  } catch {
    return false;
  }
}

/**
 * 这次发不发 thinking、发什么。AI_THINKING 显式指定（on / off，也认 enabled / disabled / true / false / 1 / 0 / yes / no）。
 * 没配置时只对 DeepSeek 的官方接口关掉思考：它省略这个参数就是开启，默认强度 high，一次提取要几分钟，
 * 还容易顶到输出上限（2026-11-27 实测：同一棵树同样的分区，经网关的 ds-flash 二十秒、八千 token；
 * 直连 deepseek-flash 一百多秒，第二个分区就顶到 16000）。别的服务商不替用户决定，照旧不发——
 * 不是每家 OpenAI 兼容接口都认这个参数。
 */
export function resolveThinkingMode(environment: Record<string, string | undefined>): ThinkingMode | undefined {
  const configured = (environment.AI_THINKING ?? "").trim().toLowerCase();
  if (["on", "enabled", "true", "1", "yes"].includes(configured)) return "enabled";
  if (["off", "disabled", "false", "0", "no"].includes(configured)) return "disabled";
  if (configured !== "") {
    throw new SnapshotLlmConfigurationError("invalid_ai_thinking", `AI_THINKING must be "on" or "off" (received "${environment.AI_THINKING}")`);
  }
  return isDeepSeekApi(environment.AI_BASE_URL) ? "disabled" : undefined;
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
    ...(options.thinking ? { thinking: options.thinking } : {}),
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
        body: JSON.stringify({
          model: options.model,
          messages,
          max_tokens: options.maxTokens ?? 16_000,
          stream: false,
          ...(options.thinking ? { thinking: { type: options.thinking } } : {}),
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
      });
      if (!response.ok) throw new Error(`AI gateway returned HTTP ${response.status}${await refusalDetail(response, options.apiKey)}`);
      const payload = await response.json() as { id?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>; usage?: unknown };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("AI gateway returned empty content");
      await options.onUsage?.(payload.usage ?? null, { requestId: payload.id ?? null, durationMs: Date.now() - startedAt });
      if (payload.choices?.[0]?.finish_reason === "length") throw new AiOutputTruncatedError();
      return content;
    },
  };
}

export function createStandaloneClientFromEnv(environment: Record<string, string | undefined>, options: Pick<OpenAICompatibleClientOptions, "onUsage" | "fetchImpl"> = {}): StructuredCompletionClient {
  const missing = ["AI_API_KEY", "AI_MODEL"].filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new SnapshotLlmConfigurationError("missing_ai_config", `Missing standalone AI configuration: ${missing.join(", ")}`);
  }
  const configuredMaxTokens = Number(environment.AI_MAX_TOKENS);
  const thinking = resolveThinkingMode(environment);
  return createOpenAICompatibleClient({
    baseUrl: environment.AI_BASE_URL,
    apiKey: environment.AI_API_KEY!,
    model: environment.AI_MODEL!,
    timeoutMs: Number(environment.AI_TIMEOUT_MS) || 180_000,
    maxTokens: Number.isInteger(configuredMaxTokens) && configuredMaxTokens > 0 ? configuredMaxTokens : 16_000,
    ...(thinking ? { thinking } : {}),
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
