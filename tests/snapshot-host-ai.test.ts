import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBridgeClient, type StructuredCompletionMessage } from "../lib/llm-client";
import { createClientForCapability, findOnPath, resolveCompletionBackend, resolveHostClient, VENDOR_CLI_PROFILES, type HostAiAdapter } from "../lib/snapshot/host-ai";
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

function syncTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "codelphi-host-ai-"));
  roots.push(root);
  return root;
}

function executable(directory: string, name: string, body: string) {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("vendor CLI profiles (host-identity-gated autodetect)", () => {
  it("locates an executable in the injected path and reports misses as null", () => {
    const root = syncTempRoot();
    executable(root, "claude", "true");
    expect(findOnPath("claude", root)).toBe(join(root, "claude"));
    expect(findOnPath("claude", "")).toBeNull();
    expect(findOnPath("claude", "/nonexistent-dir")).toBeNull();
  });

  it("prefers standalone when AI configuration is present", () => {
    const backend = resolveCompletionBackend({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    expect(backend.kind).toBe("standalone");
  });

  it("throws when standalone is explicitly requested but incomplete", () => {
    expect(() => resolveCompletionBackend({ environment: {}, standalone: true })).toThrow(/AI_API_KEY/);
  });

  it("uses the host HTTP bridge when injected", () => {
    const backend = resolveCompletionBackend({ environment: { CODELPHI_HOST_AI_BRIDGE_URL: "http://127.0.0.1:9/v1", CODELPHI_HOST_AI_BRIDGE_TOKEN: "t" }, host: "TestHost" });
    expect(backend.kind).toBe("host");
  });

  it("uses the host CLI bridge when injected", () => {
    const backend = resolveCompletionBackend({ environment: { CODELPHI_HOST_AI_COMMAND: "node", CODELPHI_HOST_AI_ARGS_JSON: '["-e","true"]' }, host: "TestHost" });
    expect(backend.kind).toBe("host");
  });

  it("reports malformed bridge args as unavailable", () => {
    const backend = resolveCompletionBackend({ environment: { CODELPHI_HOST_AI_COMMAND: "node", CODELPHI_HOST_AI_ARGS_JSON: "{not-json" }, host: "TestHost" });
    if (backend.kind !== "unavailable") throw new Error("expected unavailable backend");
    expect(backend.reasons.join("\n")).toContain("CODELPHI_HOST_AI_ARGS_JSON");
  });

  it("autodetects only the current host's own headless CLI, never another vendor's", () => {
    const root = syncTempRoot();
    executable(root, "claude", "true");
    const matched = resolveCompletionBackend({ environment: {}, host: "claude-code", pathEnv: root });
    expect(matched.kind).toBe("host");
    const other = resolveCompletionBackend({ environment: {}, host: "zcode", pathEnv: root });
    if (other.kind !== "unavailable") throw new Error("expected unavailable backend");
    expect(other.reasons.join("\n")).toContain("no known headless CLI profile for host zcode");
  });

  it("does not autodetect when the host binary is missing from PATH", () => {
    const backend = resolveCompletionBackend({ environment: {}, host: "claude-code", pathEnv: "/nonexistent-dir" });
    if (backend.kind !== "unavailable") throw new Error("expected unavailable backend");
    expect(backend.reasons.join("\n")).toContain("not on PATH");
  });

  it("collects reasons when nothing is configured", () => {
    const backend = resolveCompletionBackend({ environment: {} });
    if (backend.kind !== "unavailable") throw new Error("expected unavailable backend");
    expect(backend.reasons.length).toBeGreaterThan(0);
  });

  it("parses JSON field output for the claude profile (stdin delivery)", async () => {
    const root = syncTempRoot();
    const fake = executable(root, "claude", 'cat >/dev/null\nprintf \'{"result":"PACKAGED"}\'');
    const profile = VENDOR_CLI_PROFILES.find((candidate) => candidate.hostIds.includes("claude-code"))!;
    const client = createClientForCapability({ kind: "vendor_cli", profile, binary: fake, timeoutMs: 15_000 });
    const output = await client.complete([
      { role: "system", content: "be strict" },
      { role: "user", content: "extract" },
    ]);
    expect(output).toBe("PACKAGED");
  });

  it("delivers the prompt as an argument and returns plain output for arg profiles", async () => {
    const root = syncTempRoot();
    const fake = executable(root, "kimi", 'printf \'%s\' "$2"');
    const profile = VENDOR_CLI_PROFILES.find((candidate) => candidate.hostIds.includes("kimi"))!;
    const client = createClientForCapability({ kind: "vendor_cli", profile, binary: fake, timeoutMs: 15_000 });
    const output = await client.complete([
      { role: "system", content: "be strict" },
      { role: "user", content: "extract facts" },
    ]);
    expect(output).toContain("be strict");
    expect(output).toContain("extract facts");
  });
});
