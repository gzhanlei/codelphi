import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StructuredCompletionClient } from "../lib/llm-client";
import { configMain, publishMain, statusMain, type CliIo } from "../lib/client-publish/cli";

const exec = promisify(execFile);
const roots: string[] = [];
const AUTH = ["export function guard(status: string) {", "  if (status !== 'ready') throw new Error('not ready');", "  return true;", "}", ""].join("\n");

async function git(root: string, ...args: string[]) {
  return (await exec("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })).stdout.trim();
}

async function repository(commits = 2) {
  const root = await mkdtemp(join(tmpdir(), "codelphi-cli-publish-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await mkdir(join(root, "lib"), { recursive: true });
  for (let index = 0; index < commits; index += 1) {
    await writeFile(join(root, "lib/auth.ts"), `${AUTH}// commit ${index}\n`);
    await git(root, "add", ".");
    await git(root, "-C", root, "-c", "user.name=CLI", "-c", "user.email=cli@example.test", "commit", "-m", `commit ${index}`, "--quiet");
  }
  return { root, head: await git(root, "rev-parse", "HEAD"), previous: commits > 1 ? await git(root, "rev-parse", "HEAD~1") : null };
}

const ledger = {
  product: { description: "A fixture product.", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
  release: { title: "Fixture", summary: "Fixture" },
  changes: [],
  features: [{ name: "登录守卫", summary: "守卫", scenarios: [{ reference: "HP-1", context: "已连接", action: "进入", outcome: "放行", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 1 }] }] }],
};

function fakeModel(): StructuredCompletionClient {
  return {
    displayName: "fake-tenant-model",
    async complete(messages) {
      const prompt = messages.map((message) => message.content).join("\n");
      if (prompt.includes("产品知识库")) return JSON.stringify(ledger);
      if (prompt.includes("你在向一位不了解此变更的工程师转述")) return JSON.stringify({ files: [] });
      if (prompt.includes("复述与上下文")) return JSON.stringify({ features: [] });
      if (prompt.includes("Verify") || prompt.includes('"ok"')) return JSON.stringify({ ok: true });
      return "not json";
    },
  };
}

interface Harness {
  io: CliIo;
  out: string[];
  err: string[];
  asked: Array<{ prompt: string; secret: boolean; answer: string }>;
  requests: Array<{ url: string; method: string; body?: string }>;
  context: Record<string, unknown>;
  uploadResponses: Array<{ status: number; body: Record<string, unknown> }>;
  file: string;
}

function harness(options: { environment?: Record<string, string | undefined>; answers?: Record<string, string>; file?: string } = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const asked: Harness["asked"] = [];
  const requests: Harness["requests"] = [];
  const uploadResponses: Harness["uploadResponses"] = [];
  const context: Record<string, unknown> = {
    contractVersion: "2.0.0",
    supportedContractVersions: ["2.0.0"],
    minSupportedContractVersion: "2.0.0",
    organization: { name: "Acme" },
    products: [{ slug: "fixture", name: "Fixture", analysisExecutor: "client", currentVersionId: null, currentRevisionSha: null, repository: null }],
  };
  const file = options.file ?? join(tmpdir(), `codelphi-cli-credentials-${process.pid}-${Math.random().toString(16).slice(2)}.env`);
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    requests.push({ url: input, method, ...(init?.body ? { body: new TextDecoder().decode(init.body as Uint8Array) } : {}) });
    if (method === "GET") return new Response(JSON.stringify(context), { status: 200, headers: { "content-type": "application/json" } });
    const response = uploadResponses.shift() ?? { status: 200, body: { replayed: false, repositoryId: 7, specVersionId: 41, releaseId: 30, revisionSha: "a".repeat(40), verification: { reanalyzed: 1, deterministicallyCarried: 0, clientDeclaredUnaffected: 0 } } };
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const io: CliIo = {
    stdout: (message) => out.push(message),
    stderr: (message) => err.push(message),
    environment: { CODELPHI_CREDENTIALS_FILE: file, CODELPHI_SNAPSHOT_KEY: "sk_cd_test", ...(options.environment ?? {}) },
    ask: async (prompt, askOptions) => {
      const answer = options.answers?.[prompt] ?? "";
      asked.push({ prompt, secret: askOptions?.secret === true, answer });
      return answer;
    },
    fetchImpl,
    createClient: () => fakeModel(),
  };
  return { io, out, err, asked, requests, context, uploadResponses, file };
}

beforeEach(() => vi.stubEnv("HOME", tmpdir()));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("config", () => {
  it("shows which of the five items are set without ever printing a secret", async () => {
    const h = harness({ environment: { AI_API_KEY: "sk-model-secret", CODELPHI_SNAPSHOT_KEY: "sk_cd_upload_secret", AI_MODEL: "model-x" } });
    expect(await configMain(["--show"], h.io)).toBe(0);
    const text = h.out.join("\n");
    for (const key of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "CODELPHI_SERVER_URL", "CODELPHI_SNAPSHOT_KEY"]) expect(text).toContain(key);
    expect(text).toContain("model-x");
    expect(text).toContain("https://codelphi.com");
    expect(text).not.toContain("secret");
  });

  it("sets individual items without a prompt, verifies what changed against the real services, and saves", async () => {
    const h = harness();
    const code = await configMain(["--set", "CODELPHI_SNAPSHOT_KEY=sk_cd_write", "--set", "AI_API_KEY=sk-model", "--set", "AI_MODEL=model-x", "--set", "AI_BASE_URL=https://gateway.example/v1"], h.io);
    expect(code).toBe(0);
    const saved = await readFile(h.file, "utf8");
    expect(saved).toContain("CODELPHI_SNAPSHOT_KEY=");
    expect(saved).toContain("AI_MODEL=model-x");
    expect(h.requests.map((request) => request.url)).toEqual(["https://codelphi.com/api/client-analysis/context"]);
    expect(h.out.join("\n")).toContain("Acme");
    // 验证模型发的是真实调用，不是只测网络：客户端被调用了一次，答案是解析得出来的 JSON。
    expect(h.io.createClient).toBeDefined();
    expect(h.out.join("\n")).not.toContain("sk_cd_write");
    expect(h.out.join("\n")).not.toContain("sk-model");
  });

  it("saves nothing when the upload key is rejected", async () => {
    const h = harness();
    const file = h.io.environment.CODELPHI_CREDENTIALS_FILE as string;
    await writeFile(file, "AI_MODEL=keep-me\n");
    const reject = (async (input: string, init?: RequestInit) => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const code = await configMain(["--set", "CODELPHI_SNAPSHOT_KEY=sk_cd_bad"], { ...h.io, fetchImpl: reject });
    expect(code).toBe(1);
    expect(await readFile(file, "utf8")).toBe("AI_MODEL=keep-me\n");
    expect(h.out.join("\n")).not.toContain("sk_cd_bad");
    expect(h.err.join("\n")).not.toContain("sk_cd_bad");
  });

  it("says where requests go before asking for any key, reads keys without echo, keeps what the user skips and saves", async () => {
    const h = harness({
      answers: {
        "服务地址 [https://codelphi.com]: ": "",
        "上传 key: ": "sk_cd_typed",
        "模型服务地址 [https://api.openai.com/v1]: ": "https://gateway.example/v1",
        "API Key: ": "sk_typed",
        "模型名: ": "model-x",
      },
    });
    const code = await configMain([], h.io);
    expect(code).toBe(0);
    const prompts = h.asked.map((item) => item.prompt);
    const disclosed = h.out.findIndex((line) => line.includes("gateway.example") || line.includes("模型请求"));
    expect(disclosed).toBeGreaterThanOrEqual(0);
    expect(prompts.indexOf("上传 key: ")).toBeGreaterThan(disclosed);
    expect(h.asked.find((item) => item.prompt === "上传 key: ")?.secret).toBe(true);
    expect(h.asked.find((item) => item.prompt === "API Key: ")?.secret).toBe(true);
    expect(h.asked.find((item) => item.prompt === "模型名: ")?.secret).toBe(false);
    expect(await readFile(h.file, "utf8")).toContain("AI_API_KEY=sk_typed");
    expect(h.out.join("\n")).not.toContain("sk_typed");
    expect(h.out.join("\n")).not.toContain("sk_cd_typed");
  });

  it("refuses keys it does not know and deletes the file on --reset", async () => {
    const h = harness();
    expect(await configMain(["--set", "NOT_A_KEY=1"], h.io)).toBe(2);
    await writeFile(h.file, "AI_MODEL=x\n");
    expect(await configMain(["--reset"], h.io)).toBe(0);
    expect(await configMain(["--show"], h.io)).toBe(0);
    // 再 --show 是一个新进程一样的空输出：模型那一项是「未设置」。
    const again = harness();
    expect(await configMain(["--show"], again.io)).toBe(0);
    expect(again.out.join("\n")).not.toContain("model-x");
    await expect(readFile(h.file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("status", () => {
  it("reports the binding, the configuration and how the ledger relates to the local commit", async () => {
    const { root, head, previous } = await repository();
    const h = harness();
    h.context.products = [{ slug: "fixture", name: "Fixture", analysisExecutor: "client", currentVersionId: 3, currentRevisionSha: previous, repository: { repositoryId: 7, provider: "local", host: null, owner: null, name: null } }];
    const code = await statusMain([root, "--slug", "fixture"], h.io);
    expect(code).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("纯本地");
    expect(text).toContain("3");
    expect(text).toContain(previous!.slice(0, 12));
    expect(text).toContain(head.slice(0, 12));
    expect(text).toContain("落后");
  });
});

describe("publish", () => {
  it("refuses before calling the model when the model is not configured", async () => {
    const { root } = await repository();
    const h = harness({ environment: { AI_API_KEY: undefined, AI_MODEL: undefined } });
    expect(await publishMain([root, "--slug", "fixture"], h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("AI_API_KEY");
    expect(h.requests).toEqual([]);
  });

  it("shows what would be uploaded on --dry-run and uploads nothing", async () => {
    const { root } = await repository();
    const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    const code = await publishMain([root, "--slug", "fixture", "--dry-run"], h.io);
    expect(code).toBe(0);
    expect(h.requests.filter((request) => request.method === "POST")).toEqual([]);
    const text = h.out.join("\n");
    expect(text).toContain("全量");
    expect(text).toContain("登录守卫");
    expect(text).toContain("HP-1");
    expect(text).toContain("未上传");
  });

  it("publishes, then prints the receipt the server sent", async () => {
    const { root } = await repository();
    const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    const code = await publishMain([root, "--slug", "fixture"], h.io);
    expect(code).toBe(0);
    const uploads = h.requests.filter((request) => request.method === "POST");
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toBe("https://codelphi.com/api/products/fixture/analysis-proposals");
    const sent = JSON.parse(uploads[0].body as string);
    expect(sent.artifactKind).toBe("codelphi-analysis-proposal");
    expect(sent.proposalHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(sent)).not.toContain("sk_cd");
    const text = h.out.join("\n");
    expect(text).toContain("41");
    expect(text).toContain("fixture");
  });

  it("needs --slug unless exactly one product is analysed by the client", async () => {
    const { root } = await repository();
    const single = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    expect(await publishMain([root], single.io)).toBe(0);
    const two = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    two.context.products = [
      { slug: "a", name: "A", analysisExecutor: "client", currentVersionId: null, currentRevisionSha: null, repository: null },
      { slug: "b", name: "B", analysisExecutor: "client", currentVersionId: null, currentRevisionSha: null, repository: null },
    ];
    expect(await publishMain([root], two.io)).toBe(2);
    expect(two.err.join("\n")).toContain("--slug");
    const hosted = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    hosted.context.products = [{ slug: "hosted", name: "Hosted", analysisExecutor: "server", currentVersionId: null, currentRevisionSha: null, repository: null }];
    expect(await publishMain([root, "--slug", "hosted"], hosted.io)).toBe(2);
    expect(hosted.err.join("\n")).toContain("服务端分析");
    expect(hosted.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("stops with the reason when the state determination refuses", async () => {
    const { root, previous } = await repository();
    const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    h.context.products = [{ slug: "fixture", name: "Fixture", analysisExecutor: "client", currentVersionId: 5, currentRevisionSha: previous, repository: null }];
    const code = await publishMain([root, "--slug", "fixture"], h.io);
    expect(code).toBe(3);
    expect(h.err.join("\n")).toContain("--full");
    expect(h.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  it("treats a publish that lost the race as done when the ledger now sits on the local commit, and otherwise explains the verdict", async () => {
    const { root, head } = await repository();
    const lostButDone = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    lostButDone.uploadResponses.push({ status: 409, body: { error: "base_changed", details: { current: { specVersionId: 9, revisionSha: head }, verdict: "reusable" } } });
    // 上传之后的上下文里，账本已经在本地提交上。
    const base = lostButDone.io.fetchImpl as typeof fetch;
    lostButDone.io.fetchImpl = (async (input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        lostButDone.context.products = [{ slug: "fixture", name: "Fixture", analysisExecutor: "client", currentVersionId: 9, currentRevisionSha: head, repository: null }];
        return base(input, init);
      }
      return base(input, init);
    }) as typeof fetch;
    expect(await publishMain([root, "--slug", "fixture"], lostButDone.io)).toBe(0);
    expect(lostButDone.out.join("\n")).toContain(head.slice(0, 12));

    const moved = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    moved.uploadResponses.push({ status: 409, body: { error: "base_changed", details: { current: { specVersionId: 9, revisionSha: "c".repeat(40) }, changedFeatureKeys: ["登录守卫"], verdict: "reanalyze" } } });
    expect(await publishMain([root, "--slug", "fixture"], moved.io)).toBe(4);
    expect(moved.err.join("\n")).toContain("重新");
  });

  it("tells the user to upgrade when the server no longer speaks this client's contract", async () => {
    const { root } = await repository();
    const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    h.context.minSupportedContractVersion = "3.0.0";
    expect(await publishMain([root, "--slug", "fixture"], h.io)).toBe(5);
    expect(h.err.join("\n")).toContain("升级");
  });
});

describe("snapshot entry dispatches the client analysis commands", () => {
  it("routes config, status and publish to their implementations with the caller's output and environment", async () => {
    const { main } = await import("../scripts/snapshot");
    const file = join(tmpdir(), `codelphi-cli-dispatch-${Math.random().toString(16).slice(2)}.env`);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["config", "--show"], { stdout: (message) => out.push(message), stderr: (message) => err.push(message), environment: { CODELPHI_CREDENTIALS_FILE: file } });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("AI_MODEL");
    expect(await main(["publish"], { stdout: (message) => out.push(message), stderr: (message) => err.push(message), environment: {} })).toBe(2);
    expect(err.join("\n")).toContain("--slug");
    expect(await main(["status"], { stdout: (message) => out.push(message), stderr: (message) => err.push(message), environment: {} })).toBe(2);
  });

  it("speaks English when asked", async () => {
    const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    expect(await publishMain([join(tmpdir()), "--slug", "missing", "--language", "en"], h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("no product named");
  });
});
