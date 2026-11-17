import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBridgeClient, type StructuredCompletionMessage } from "../lib/llm-client";
import { createClientForCapability, resolveHostClient, type HostAiAdapter } from "../lib/snapshot/host-ai";
import { runSnapshot } from "../lib/snapshot/run";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(root: string, ...args: string[]) {
  return exec("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-host-repo-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "snapshot@example.test");
  await git(root, "config", "user.name", "Snapshot Test");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "host-fixture" }));
  await writeFile(join(root, "index.ts"), "export const feature = true;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

const content = JSON.stringify({
  product: { description: "Host product", evidence: [{ path: "index.ts", startLine: 1 }] },
  release: { title: "Snapshot", summary: "Snapshot" },
  changes: [],
  features: [{ name: "Host feature", summary: "Feature", scenarios: [{ reference: "HP-1", context: "User", action: "Uses feature", outcome: "Succeeds", category: "happy", evidence: [{ path: "index.ts", startLine: 1 }] }] }],
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("host AI adapters", () => {
  it("uses an in-process host client and disposes the adapter", async () => {
    const root = await repository();
    const complete = vi.fn(async (_messages: StructuredCompletionMessage[]) => content);
    const dispose = vi.fn(async () => undefined);
    const adapter: HostAiAdapter = {
      id: "test-host",
      discover: vi.fn(async () => ({ kind: "in_process" as const, client: { complete, displayName: "TestHost current model" } })),
      dispose,
    };
    const result = await runSnapshot({ target: root, outputLanguage: "en", environment: {}, hostContext: { host: "test-host", adapters: [adapter] } });
    expect(complete).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(result.report.modelName).toBe("TestHost current model");
  });

  it("uses a host CLI protocol without selecting a model", async () => {
    const root = await mkdtemp(join(tmpdir(), "codelphi-host-cli-"));
    roots.push(root);
    const script = join(root, "host-cli.cjs");
    await writeFile(script, `let input="";process.stdin.on("data",c=>input+=c);process.stdin.on("end",()=>{const request=JSON.parse(input);if(request.model)process.exit(9);process.stdout.write(JSON.stringify({content:${JSON.stringify(content)}}));});`);
    const client = createClientForCapability({ kind: "host_cli", command: process.execPath, args: [script], displayName: "CLI host model" });
    await expect(client.complete([{ role: "user", content: "hello" }])).resolves.toBe(content);
  });

  it("uses an explicitly injected local bridge and never sends a model selection", async () => {
    const root = await repository();
    const requests: Array<{ body: { model?: string }; authorization?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      requests.push({ body: JSON.parse(init?.body ?? "{}"), authorization: init?.headers?.Authorization });
      return new Response(JSON.stringify({ content, displayName: "Bridge current model" }), { status: 200 });
    }));
    const result = await runSnapshot({
      target: root,
      outputLanguage: "en",
      environment: {
        CODELPHI_HOST_AI_BRIDGE_URL: "http://127.0.0.1:9999/host-completion",
        CODELPHI_HOST_AI_BRIDGE_TOKEN: "short-lived-token",
        CODELPHI_HOST_MODEL: "Bridge current model",
      },
      hostContext: { host: "bridge-host" },
    });
    expect(result.report.modelName).toBe("Bridge current model");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0].body.model).toBeUndefined();
    expect(requests[0].authorization).toBe("Bearer short-lived-token");
  });

  it("fails with host_ai_unavailable and never silently falls back to standalone variables", async () => {
    const unavailable: HostAiAdapter = { id: "closed-host", discover: vi.fn(async () => ({ kind: "unavailable" as const, reason: "No official model API" })) };
    await expect(runSnapshot({
      target: "/not/needed",
      outputLanguage: "en",
      environment: { AI_API_KEY: "secret", AI_MODEL: "must-not-use" },
      hostContext: { host: "closed-host", adapters: [unavailable] },
    })).rejects.toMatchObject({ code: "host_ai_unavailable" });
  });

  it("allows standalone only when explicitly selected in a host context", async () => {
    await expect(runSnapshot({
      target: "/not/needed",
      outputLanguage: "en",
      environment: {},
      standalone: true,
      hostContext: { host: "closed-host", adapters: [{ id: "closed", discover: async () => ({ kind: "unavailable", reason: "closed" }) }] },
    })).rejects.toMatchObject({ code: "missing_ai_config" });
  });

  it("keeps host bridge transport independent of OpenAI model parameters", async () => {
    const complete = vi.fn(async (_input: unknown, _init?: { body?: string }) => new Response(JSON.stringify({ content: "ok" }), { status: 200 }));
    const client = createHostBridgeClient({ endpoint: "http://localhost/bridge", fetchImpl: complete as unknown as typeof fetch });
    await expect(client.complete([{ role: "user", content: "hello" }])).resolves.toBe("ok");
    const init = complete.mock.calls[0][1] as { body: string };
    expect(JSON.parse(init.body)).toEqual({ messages: [{ role: "user", content: "hello" }] });
  });
});
