import { spawn } from "node:child_process";
import { createHostBridgeClient, type StructuredCompletionClient, type StructuredCompletionMessage } from "../llm-client";

export class SnapshotHostAiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotHostAiError";
  }
}

export type HostAiCapability =
  | { kind: "in_process"; client: StructuredCompletionClient; dispose?: () => Promise<void> }
  | { kind: "host_cli"; command: string; args: string[]; displayName?: string; environment?: Record<string, string>; timeoutMs?: number }
  | { kind: "local_bridge"; endpoint: string; headers?: Record<string, string>; displayName?: string; dispose?: () => Promise<void> }
  | { kind: "unavailable"; reason: string };

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

export function createClientForCapability(capability: Exclude<HostAiCapability, { kind: "unavailable" }>): StructuredCompletionClient {
  if (capability.kind === "in_process") return capability.client;
  if (capability.kind === "local_bridge") {
    return createHostBridgeClient({ endpoint: capability.endpoint, headers: capability.headers, displayName: capability.displayName });
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
