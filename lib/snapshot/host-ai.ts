import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { accessSync, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createHostBridgeClient, createStandaloneClientFromEnv, SnapshotLlmConfigurationError, type StructuredCompletionClient, type StructuredCompletionMessage } from "../llm-client";

/**
 * complete 通道探测链（按优先级）：
 * 1. standalone —— 用户显式提供的 OpenAI 兼容 AI 配置（--env-file / AI_*）。
 * 2. 宿主显式桥 —— 宿主注入的当前模型访问通道（CODELPHI_HOST_AI_*，见 environmentAdapter）。
 * 3. 宿主 headless CLI 自动探测 —— 仅匹配 CODELPHI_SKILL_HOST 标明的当前宿主自己的
 *    CLI（不跨厂商探测，避免意外消耗其他订阅额度）。
 * 4. 以上皆无 —— 宿主原生模式：由宿主 agent 逐个执行工作单（SKILL.md 第 3 步）。
 */

export class SnapshotHostAiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotHostAiError";
  }
}

export type HostAiCapability =
  | { kind: "in_process"; client: StructuredCompletionClient; dispose?: () => Promise<void> }
  /** 宿主注入的桥接命令：stdin 收 JSON {messages}，stdout 出 {content} 或 OpenAI 形状。 */
  | { kind: "host_cli"; command: string; args: string[]; displayName?: string; environment?: Record<string, string>; timeoutMs?: number }
  /** 已知宿主的 headless 子命令（claude -p / codex exec / …）：一次调用 ≈ 一次补全。binary 为探测到的可执行文件路径。 */
  | { kind: "vendor_cli"; profile: VendorCliProfile; binary: string; timeoutMs?: number }
  | { kind: "local_bridge"; endpoint: string; headers?: Record<string, string>; displayName?: string; dispose?: () => Promise<void> }
  | { kind: "unavailable"; reason: string };

export interface VendorCliProfile {
  /** 触发该档案的宿主身份（CODELPHI_SKILL_HOST 值，小写比较）。 */
  hostIds: string[];
  command: string;
  args: string[];
  promptDelivery: "stdin" | "arg";
  output: "json_field" | "plain";
  resultField?: string;
  displayName: string;
}

/** 已知宿主的 headless 完成通道档案。只匹配「当前宿主自己的 CLI」，绝不跨厂商探测。 */
export const VENDOR_CLI_PROFILES: VendorCliProfile[] = [
  { hostIds: ["claude-code", "claude"], command: "claude", args: ["-p", "--output-format", "json"], promptDelivery: "stdin", output: "json_field", resultField: "result", displayName: "Claude Code current model" },
  { hostIds: ["codex", "codex-cli"], command: "codex", args: ["exec"], promptDelivery: "arg", output: "plain", displayName: "Codex current model" },
  { hostIds: ["gemini", "gemini-cli"], command: "gemini", args: ["-p"], promptDelivery: "arg", output: "plain", displayName: "Gemini CLI current model" },
  { hostIds: ["cursor", "cursor-cli"], command: "cursor-agent", args: ["-p"], promptDelivery: "arg", output: "plain", displayName: "Cursor agent current model" },
  { hostIds: ["kimi", "kimi-code"], command: "kimi", args: ["-p"], promptDelivery: "arg", output: "plain", displayName: "Kimi CLI current model" },
  { hostIds: ["qwen", "qwen-code"], command: "qwen", args: ["-p"], promptDelivery: "arg", output: "plain", displayName: "Qwen Code current model" },
  { hostIds: ["opencode"], command: "opencode", args: ["run"], promptDelivery: "arg", output: "plain", displayName: "OpenCode current model" },
  { hostIds: ["antigravity", "agy"], command: "agy", args: ["-p"], promptDelivery: "arg", output: "plain", displayName: "Antigravity CLI current model" },
];

/** 在 PATH 里定位可执行文件；找不到返回 null。供探测链与测试注入使用。 */
export function findOnPath(command: string, pathEnv: string = process.env.PATH ?? "", platform: NodeJS.Platform = process.platform): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, command + extension);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // 不在 PATH 里或不可执行，继续找下一个。
      }
    }
  }
  return null;
}

export interface HostAiAdapter {
  id: string;
  discover: () => Promise<HostAiCapability>;
  dispose?: () => Promise<void>;
}

export interface HostClientSession {
  client: StructuredCompletionClient;
  dispose: () => Promise<void>;
}

function hostCliCompletion(capability: Extract<HostAiCapability, { kind: "host_cli" }>, messages: StructuredCompletionMessage[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(capability.command, capability.args, {
      env: { ...process.env, ...capability.environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, capability.timeoutMs ?? 180_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 16 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new SnapshotHostAiError(timedOut ? "host_cli_timeout" : "host_cli_failed", timedOut ? `Host AI CLI exceeded ${capability.timeoutMs ?? 180_000}ms` : `Host AI CLI exited with code ${code ?? "unknown"}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (!output) {
        reject(new SnapshotHostAiError("host_cli_empty", "Host AI CLI returned empty content"));
        return;
      }
      try {
        const parsed = JSON.parse(output) as { content?: string; choices?: Array<{ message?: { content?: string } }> };
        const content = parsed.content ?? parsed.choices?.[0]?.message?.content;
        resolve(content ?? output);
      } catch {
        resolve(output);
      }
    });
    child.stdin.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.end(JSON.stringify({ messages }));
  });
}

/** vendor_cli 档案：工单消息串成一个 prompt（system 在前），按档案的输入/输出形状交付。 */
function vendorCliCompletion(capability: Extract<HostAiCapability, { kind: "vendor_cli" }>, messages: StructuredCompletionMessage[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const profile = capability.profile;
    const prompt = messages.map((message) => message.content).join("\n\n");
    const child = spawn(capability.binary, profile.promptDelivery === "arg" ? [...profile.args, prompt] : profile.args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, capability.timeoutMs ?? 300_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 32 * 1024 * 1024) child.kill();
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new SnapshotHostAiError("host_cli_timeout", `Host AI CLI exceeded ${capability.timeoutMs ?? 300_000}ms`));
        return;
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim().slice(-400);
        reject(new SnapshotHostAiError("host_cli_failed", `Host AI CLI exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : ""}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (!output) {
        reject(new SnapshotHostAiError("host_cli_empty", "Host AI CLI returned empty content"));
        return;
      }
      if (profile.output === "json_field" && profile.resultField) {
        try {
          const parsed = JSON.parse(output) as Record<string, unknown>;
          const content = parsed[profile.resultField];
          if (typeof content === "string" && content.trim()) {
            resolve(content);
            return;
          }
        } catch {
          // 非 JSON 输出按纯文本处理。
        }
      }
      resolve(output);
    });
    if (profile.promptDelivery === "stdin") child.stdin.end(prompt);
    else child.stdin.end();
    child.stdin.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function createClientForCapability(capability: Exclude<HostAiCapability, { kind: "unavailable" }>): StructuredCompletionClient {
  if (capability.kind === "in_process") return capability.client;
  if (capability.kind === "local_bridge") {
    return createHostBridgeClient({ endpoint: capability.endpoint, headers: capability.headers, displayName: capability.displayName });
  }
  if (capability.kind === "vendor_cli") {
    return {
      displayName: capability.profile.displayName,
      complete: (messages) => vendorCliCompletion(capability, messages),
    };
  }
  return {
    displayName: capability.displayName ?? "Host current model",
    complete: (messages) => hostCliCompletion(capability, messages),
  };
}

function environmentAdapter(host: string, environment: Record<string, string | undefined>): HostAiAdapter {
  return {
    id: `${host}-explicit-bridge`,
    discover: async () => {
      const endpoint = environment.CODELPHI_HOST_AI_BRIDGE_URL?.trim();
      if (endpoint) {
        const token = environment.CODELPHI_HOST_AI_BRIDGE_TOKEN;
        return {
          kind: "local_bridge",
          endpoint,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          displayName: environment.CODELPHI_HOST_MODEL?.trim() || `${host} current model`,
        };
      }
      const command = environment.CODELPHI_HOST_AI_COMMAND?.trim();
      if (command) {
        let args: string[] = [];
        try {
          const parsed: unknown = JSON.parse(environment.CODELPHI_HOST_AI_ARGS_JSON ?? "[]");
          if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("not a string array");
          args = parsed;
        } catch {
          throw new SnapshotHostAiError("host_ai_unavailable", "CODELPHI_HOST_AI_ARGS_JSON must be a JSON string array");
        }
        return { kind: "host_cli", command, args, displayName: environment.CODELPHI_HOST_MODEL?.trim() || `${host} current model`, timeoutMs: Number(environment.CODELPHI_HOST_AI_TIMEOUT_MS) || 180_000 };
      }
      return { kind: "unavailable", reason: `${host} did not inject an official active-model bridge or CLI` };
    },
  };
}

export async function resolveHostClient(options: {
  host: string;
  environment: Record<string, string | undefined>;
  adapters?: HostAiAdapter[];
}): Promise<HostClientSession> {
  const adapters = options.adapters ?? [environmentAdapter(options.host, options.environment)];
  const reasons: string[] = [];
  for (const adapter of adapters) {
    try {
      const capability = await adapter.discover();
      if (capability.kind === "unavailable") {
        reasons.push(capability.reason);
        continue;
      }
      return {
        client: createClientForCapability(capability),
        dispose: async () => {
          if ("dispose" in capability) await capability.dispose?.();
          await adapter.dispose?.();
        },
      };
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new SnapshotHostAiError("host_ai_unavailable", `${options.host} has no usable active-model interface${reasons.length ? `: ${reasons.join("; ")}` : ""}`);
}

export type CompletionBackend =
  | { kind: "standalone"; client: StructuredCompletionClient }
  | { kind: "host"; client: StructuredCompletionClient }
  | { kind: "unavailable"; reasons: string[] };

/**
 * complete 子命令的通道探测链（纯同步：只读环境变量与 PATH）。
 * standalone（显式请求，或 AI_API_KEY+AI_MODEL 已配置）→ 宿主显式桥（CODELPHI_HOST_AI_*）→
 * 宿主身份门控的 headless CLI → unavailable（附全部探测原因）。
 */
export function resolveCompletionBackend(options: {
  environment: Record<string, string | undefined>;
  standalone?: boolean;
  host?: string;
  pathEnv?: string;
}): CompletionBackend {
  const environment = options.environment;
  const reasons: string[] = [];
  const standaloneRequested = options.standalone === true;
  const standaloneConfigured = Boolean(environment.AI_API_KEY?.trim() && environment.AI_MODEL?.trim());
  if (standaloneRequested || standaloneConfigured) {
    try {
      return { kind: "standalone", client: createStandaloneClientFromEnv(environment) };
    } catch (error) {
      if (error instanceof SnapshotLlmConfigurationError && !standaloneRequested) {
        reasons.push("standalone AI configuration incomplete");
      } else {
        throw error;
      }
    }
  }
  const host = options.host?.trim();
  if (host) {
    try {
      const capability = discoverHostCapabilitySync(host, environment, options.pathEnv);
      return { kind: "host", client: createClientForCapability(capability) };
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    reasons.push("CODELPHI_SKILL_HOST is not set; host bridge and CLI autodetect are disabled");
  }
  return { kind: "unavailable", reasons };
}

function discoverHostCapabilitySync(host: string, environment: Record<string, string | undefined>, pathEnv?: string): Exclude<HostAiCapability, { kind: "unavailable" }> {
  // 显式桥：环境变量读取是纯同步操作，直接展开 environmentAdapter 的判定逻辑。
  const endpoint = environment.CODELPHI_HOST_AI_BRIDGE_URL?.trim();
  if (endpoint) {
    const token = environment.CODELPHI_HOST_AI_BRIDGE_TOKEN;
    return { kind: "local_bridge", endpoint, headers: token ? { Authorization: `Bearer ${token}` } : undefined, displayName: environment.CODELPHI_HOST_MODEL?.trim() || `${host} current model` };
  }
  const command = environment.CODELPHI_HOST_AI_COMMAND?.trim();
  if (command) {
    let args: string[] = [];
    try {
      const parsed: unknown = JSON.parse(environment.CODELPHI_HOST_AI_ARGS_JSON ?? "[]");
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("not a string array");
      args = parsed;
    } catch {
      throw new SnapshotHostAiError("host_ai_unavailable", "CODELPHI_HOST_AI_ARGS_JSON must be a JSON string array");
    }
    return { kind: "host_cli", command, args, displayName: environment.CODELPHI_HOST_MODEL?.trim() || `${host} current model`, timeoutMs: Number(environment.CODELPHI_HOST_AI_TIMEOUT_MS) || 180_000 };
  }
  // 宿主身份门控的 headless CLI 自动探测：PATH 扫描同样纯同步。
  const normalized = host.toLowerCase();
  const profile = VENDOR_CLI_PROFILES.find((candidate) => candidate.hostIds.includes(normalized));
  if (!profile) throw new SnapshotHostAiError("host_ai_unavailable", `no known headless CLI profile for host ${host}`);
  const binary = findOnPath(profile.command, pathEnv);
  if (!binary) throw new SnapshotHostAiError("host_ai_unavailable", `${profile.command} is not on PATH`);
  return { kind: "vendor_cli", profile, binary, timeoutMs: Number(environment.CODELPHI_HOST_AI_TIMEOUT_MS) || 300_000 };
}
