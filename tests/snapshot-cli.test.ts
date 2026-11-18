import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "./fixtures/snapshot-report.json";
import { main } from "../scripts/snapshot";
import { runSnapshot } from "../lib/snapshot/run";
import type { StructuredCompletionClient, StructuredCompletionMessage } from "../lib/llm-client";
import type { SnapshotReportData } from "../lib/snapshot/types";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(root: string, ...args: string[]) {
  return exec("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-cli-repo-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.email", "snapshot@example.test");
  await git(root, "config", "user.name", "Snapshot Test");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "cli-fixture", version: "1.0.0" }));
  await writeFile(join(root, "index.ts"), "export function feature() { return true; }\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial product");
  return root;
}

function report(): SnapshotReportData {
  return structuredClone(fixture) as SnapshotReportData;
}

function completionPayload(path = "index.ts") {
  return JSON.stringify({
    product: { description: "A fixture product", evidence: [{ path, startLine: 1 }] },
    release: { title: "Snapshot", summary: "Snapshot" },
    changes: [],
    features: [{ name: "Fixture feature", summary: "A feature", scenarios: [{ reference: "HP-1", context: "User", action: "Runs feature", outcome: "Succeeds", category: "happy", evidence: [{ path, startLine: 1 }] }] }],
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("snapshot programmatic runner", () => {
  it("uses a host client without standalone AI variables and preserves the requested HTML language", async () => {
    const root = await repository();
    const complete = vi.fn(async (_messages: StructuredCompletionMessage[]) => completionPayload());
    const client: StructuredCompletionClient = { complete, displayName: "Host current model" };
    const result = await runSnapshot({ target: root, outputLanguage: "zh-CN", client, environment: {} });
    expect(complete).toHaveBeenCalled();
    expect(result.report.language).toBe("zh-CN");
    expect(result.report.modelName).toBe("Host current model");
    expect(result.html).toContain('<html lang="zh-CN">');
    expect(result.report.snapshot.revision).toMatch(/^[0-9a-f]{40}$/);
  });

  it("fails clearly without standalone configuration when no host client exists", async () => {
    const root = await repository();
    await expect(runSnapshot({ target: root, outputLanguage: "en", environment: {} })).rejects.toThrow(/AI_MODEL|AI_API_KEY/);
  });
});

describe("snapshot CLI", () => {
  it("prints help without requiring AI configuration", async () => {
    const stdout = vi.fn();
    const code = await main(["--help"], { stdout, stderr: vi.fn() });
    expect(code).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("--language"));
  });

  it("loads AI configuration only from an explicit env file and passes invocation language", async () => {
    const root = await repository();
    const envFile = join(root, "ai.env");
    await writeFile(envFile, "AI_BASE_URL=http://127.0.0.1:9999\nAI_API_KEY=secret\nAI_MODEL=standalone-model\nDATABASE_URL=must-not-load\n");
    const run = vi.fn(async (options) => {
      expect(options.outputLanguage).toBe("en");
      expect(options.environment).toMatchObject({ AI_BASE_URL: "http://127.0.0.1:9999", AI_API_KEY: "secret", AI_MODEL: "standalone-model" });
      expect(options.environment.DATABASE_URL).toBeUndefined();
      return { report: report(), html: "<html lang=\"en\">report</html>" };
    });
    const output = join(root, "result.html");
    const code = await main([root, "--language", "en", "--env-file", envFile, "--output", output], { run, stdout: vi.fn(), stderr: vi.fn(), environment: {} });
    expect(code).toBe(0);
    expect(await readFile(output, "utf8")).toBe("<html lang=\"en\">report</html>");
  });

  it("rejects invalid language as a usage error", async () => {
    const code = await main(["/tmp/repo", "--language", "fr"], { stdout: vi.fn(), stderr: vi.fn() });
    expect(code).toBe(2);
  });

  it("does not overwrite an existing report without force", async () => {
    const root = await repository();
    const output = join(root, "existing.html");
    await writeFile(output, "original");
    const run = vi.fn(async () => ({ report: report(), html: "replacement" }));
    const code = await main([root, "--output", output], { run, stdout: vi.fn(), stderr: vi.fn(), environment: {} });
    expect(code).toBe(1);
    expect(await readFile(output, "utf8")).toBe("original");
  });

  it("reports partition and presentation progress in the invocation language", async () => {
    const root = await repository();
    const output = join(root, "progress.html");
    const messages: string[] = [];
    const run = vi.fn(async (options) => {
      options.onProgress?.({ stage: "plan", status: "complete", total: 2 });
      options.onProgress?.({ stage: "partition", status: "start", current: 1, total: 2 });
      options.onProgress?.({ stage: "partition", status: "complete", current: 1, total: 2, durationMs: 1234, retries: 1 });
      options.onProgress?.({ stage: "presentation", status: "start" });
      options.onProgress?.({ stage: "presentation", status: "complete", durationMs: 500 });
      return { report: report(), html: "report" };
    });
    const code = await main([root, "--language", "zh-CN", "--output", output], { run, stdout: vi.fn(), stderr: (message) => messages.push(message), environment: {} });
    expect(code).toBe(0);
    expect(messages.join("\n")).toContain("共 2 个分区");
    expect(messages.join("\n")).toContain("分区 1/2：开始提取");
    expect(messages.join("\n")).toContain("完成，耗时 1.2 秒，重试 1 次");
    expect(messages.join("\n")).toContain("项目地图生成完成");
  });

  it("uses an atomic no-clobber write for a new report", async () => {
    const root = await repository();
    const output = join(root, "new-report.html");
    const run = vi.fn(async () => ({ report: report(), html: "complete report" }));
    const code = await main([root, "--output", output], { run, stdout: vi.fn(), stderr: vi.fn(), environment: {} });
    expect(code).toBe(0);
    expect(await readFile(output, "utf8")).toBe("complete report");
    await expect(readFile(`${output}.tmp`, "utf8")).rejects.toThrow();
  });
});
