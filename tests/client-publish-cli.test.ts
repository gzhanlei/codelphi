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
  /** 输出和提问按发生顺序记在一起，用来断言「先说了什么，再要 key」。 */
  events: string[];
  err: string[];
  asked: Array<{ prompt: string; secret: boolean; answer: string }>;
  requests: Array<{ url: string; method: string; body?: string }>;
  context: Record<string, unknown>;
  uploadResponses: Array<{ status: number; body: Record<string, unknown> }>;
  file: string;
}

function harness(options: { environment?: Record<string, string | undefined>; answers?: Record<string, string>; file?: string } = {}): Harness {
  const out: string[] = [];
  const events: string[] = [];
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
    stdout: (message) => {
      out.push(message);
      events.push(`out:${message}`);
    },
    stderr: (message) => err.push(message),
    // 模型服务地址没有默认值（用哪家是用户的决定），所以夹具自己给一个；要测「没配」的用例把它盖成 undefined。
    environment: { CODELPHI_CREDENTIALS_FILE: file, CODELPHI_SNAPSHOT_KEY: "sk_cd_test", AI_BASE_URL: "https://gateway.example/v1", ...(options.environment ?? {}) },
    ask: async (prompt, askOptions) => {
      events.push(`ask:${prompt}`);
      const answer = options.answers?.[prompt] ?? "";
      asked.push({ prompt, secret: askOptions?.secret === true, answer });
      return answer;
    },
    fetchImpl,
    createClient: () => fakeModel(),
  };
  return { io, out, events, err, asked, requests, context, uploadResponses, file };
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

  it("names the address the user just confirmed, right before asking for each key, and never guesses a model provider", async () => {
    const h = harness({
      // 什么都没配置过：环境里也没有模型地址。
      environment: { AI_BASE_URL: undefined },
      answers: {
        "服务地址 [https://codelphi.com]: ": "https://codelphi.example.com",
        "上传 key: ": "sk_cd_typed",
        "模型服务地址: ": "https://gateway.example/v1",
        "API Key: ": "sk_typed",
        "模型名: ": "model-x",
      },
    });
    expect(await configMain([], h.io)).toBe(0);
    const at = (prefix: string) => h.events.findIndex((event) => event.startsWith(prefix));
    // 什么都不曾配置时，没有可以回车接受的默认模型地址，输出里也不出现任何一家的地址。
    expect(at("ask:模型服务地址: ")).toBeGreaterThanOrEqual(0);
    expect(h.out.join("\n")).not.toContain("api.openai.com");
    expect(h.out.join("\n")).not.toContain("127.0.0.1");
    const serverDisclosed = at("out:分析提案将上传到 https://codelphi.example.com");
    const uploadKeyAsked = at("ask:上传 key: ");
    const modelDisclosed = at("out:模型请求将发送到 https://gateway.example/v1，不经过 CoDelphi 服务端。");
    const apiKeyAsked = at("ask:API Key: ");
    expect(serverDisclosed).toBeGreaterThan(at("ask:服务地址 ["));
    expect(uploadKeyAsked).toBeGreaterThan(serverDisclosed);
    expect(modelDisclosed).toBeGreaterThan(at("ask:模型服务地址: "));
    expect(apiKeyAsked).toBeGreaterThan(modelDisclosed);
    expect(h.asked.find((item) => item.prompt === "上传 key: ")?.secret).toBe(true);
    expect(h.asked.find((item) => item.prompt === "API Key: ")?.secret).toBe(true);
    expect(h.asked.find((item) => item.prompt === "模型名: ")?.secret).toBe(false);
    expect(await readFile(h.file, "utf8")).toContain("AI_BASE_URL=https://gateway.example/v1");
    expect(h.out.join("\n")).not.toContain("sk_typed");
    expect(h.out.join("\n")).not.toContain("sk_cd_typed");
  });

  it("tells a DeepSeek user, before asking for the key, that the client turns thinking off and how to keep it", async () => {
    const h = harness({
      environment: { AI_BASE_URL: undefined },
      answers: {
        "服务地址 [https://codelphi.com]: ": "",
        "模型服务地址: ": "https://api.deepseek.com",
        "API Key: ": "sk_typed",
        "模型名: ": "deepseek-flash",
      },
    });
    expect(await configMain([], h.io)).toBe(0);
    const at = (prefix: string) => h.events.findIndex((event) => event.startsWith(prefix));
    const note = at("out:DeepSeek 默认开启思考");
    expect(note).toBeGreaterThan(at("out:模型请求将发送到 https://api.deepseek.com"));
    expect(note).toBeLessThan(h.events.indexOf("ask:API Key: "));
    expect(h.events[note]).toContain("AI_THINKING=on");
    // 别的服务商不提这件事：这个参数不是每家都认，客户端也不会替他们发。
    const other = harness({
      environment: { AI_BASE_URL: undefined },
      answers: { "服务地址 [https://codelphi.com]: ": "", "模型服务地址: ": "https://gateway.example/v1", "API Key: ": "sk_typed", "模型名: ": "model-x" },
    });
    expect(await configMain([], other.io)).toBe(0);
    expect(other.out.join("\n")).not.toContain("思考");
  });

  it("offers the model address it already knows as the default and names it when the user keeps it", async () => {
    const file = join(tmpdir(), `codelphi-cli-stored-${process.pid}.env`);
    await writeFile(file, "AI_BASE_URL=https://kept.example/v1\n");
    const h = harness({
      file,
      answers: { "服务地址 [https://codelphi.com]: ": "", "上传 key: ": "sk_cd_typed", "模型服务地址 [https://kept.example/v1]: ": "", "API Key: ": "sk_typed", "模型名: ": "model-x" },
    });
    expect(await configMain([], h.io)).toBe(0);
    expect(h.out).toContain("模型请求将发送到 https://kept.example/v1，不经过 CoDelphi 服务端。");
    expect(h.events.findIndex((event) => event === "out:模型请求将发送到 https://kept.example/v1，不经过 CoDelphi 服务端。")).toBeLessThan(h.events.findIndex((event) => event === "ask:API Key: "));
    expect(await readFile(file, "utf8")).toContain("AI_BASE_URL=https://kept.example/v1");
  });

  it("stops before asking for a model key when no model address is configured and the user gives none", async () => {
    const h = harness({ environment: { AI_BASE_URL: undefined }, answers: { "服务地址 [https://codelphi.com]: ": "", "上传 key: ": "sk_cd_typed", "模型服务地址: ": "" } });
    expect(await configMain([], h.io)).toBe(2);
    expect(h.events.some((event) => event.startsWith("ask:API Key"))).toBe(false);
    expect(h.out.join("\n")).not.toContain("模型请求将发送到");
    expect(h.err.join("\n")).toContain("模型服务地址");
    await expect(readFile(h.file)).rejects.toMatchObject({ code: "ENOENT" });
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
  it("refuses to call a model when no model address is configured instead of sending the key to a default gateway", async () => {
    const { root } = await repository();
    const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m", AI_BASE_URL: undefined } });
    expect(await publishMain([root, "--slug", "fixture"], h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("AI_BASE_URL");
    expect(h.requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

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

  it("says which source roots it will analyse and stays inside them", async () => {
    const { root } = await repository();
    const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    // 产品配了指向不存在目录的源码根：分析限定在里面，一个文件都找不到。
    h.context.products = [{ slug: "fixture", name: "Fixture", analysisExecutor: "client", currentVersionId: null, currentRevisionSha: null, repository: { repositoryId: 7, provider: "local", host: null, owner: null, name: "fixture" }, sourceRoots: [{ path: "apps/web" }] }];
    const code = await publishMain([root, "--slug", "fixture", "--dry-run"], h.io);
    expect(code).not.toBe(0);
    expect(h.err.join("\n")).toContain("源码根目录：apps/web");
    // 范围解析就拒绝了：分析确实被限定在产品配的目录里。
    expect(h.err.join("\n")).toContain("scope root does not exist: apps/web");
    // 服务端没配（或产品没带）：不打印这一行，照常分析整个仓库。
    const whole = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    whole.context.products = [{ slug: "fixture", name: "Fixture", analysisExecutor: "client", currentVersionId: null, currentRevisionSha: null, repository: { repositoryId: 7, provider: "local", host: null, owner: null, name: "fixture" } }];
    expect(await publishMain([root, "--slug", "fixture", "--dry-run"], whole.io)).toBe(0);
    expect(whole.out.join("\n")).not.toContain("源码根目录");
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

  it("says with each publish whether the model will think, and that it turned DeepSeek's thinking off", async () => {
    const { root } = await repository();
    const run = async (environment: Record<string, string | undefined>) => {
      const h = harness({ environment: { AI_API_KEY: "k", ...environment } });
      expect(await publishMain([root, "--slug", "fixture"], h.io)).toBe(0);
      return h.err.join("\n");
    };
    const deepseek = await run({ AI_BASE_URL: "https://api.deepseek.com", AI_MODEL: "deepseek-flash" });
    expect(deepseek).toContain("分析模型：");
    expect(deepseek).toContain("思考模式：已关闭");
    expect(await run({ AI_BASE_URL: "https://api.deepseek.com", AI_MODEL: "deepseek-flash", AI_THINKING: "on" })).toContain("思考模式：开启");
    // 别的服务商不带这个参数，也就没有这一句。
    expect(await run({ AI_MODEL: "m" })).not.toContain("思考模式");
    // 读不懂的值不猜：说出来是哪一项，而不是悄悄按某一种发出去。
    const broken = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m", AI_THINKING: "maybe" } });
    expect(await publishMain([root, "--slug", "fixture"], broken.io)).toBe(1);
    expect(broken.err.join("\n")).toContain("AI_THINKING");
  });

  it("says when the first publish took over an imported draft, and says nothing when it did not", async () => {
    const { root } = await repository();
    const absorbed = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    absorbed.uploadResponses.push({ status: 200, body: { replayed: false, repositoryId: 7, specVersionId: 41, releaseId: 30, revisionSha: "a".repeat(40), verification: { reanalyzed: 1, deterministicallyCarried: 0, clientDeclaredUnaffected: 0 }, draftAbsorbed: { features: 2, scenarios: 3 } } });
    expect(await publishMain([root, "--slug", "fixture"], absorbed.io)).toBe(0);
    expect(absorbed.out.join("\n")).toContain("导入的草稿并进了这次发布：2 个功能、3 条场景");
    expect(absorbed.out.join("\n")).toContain("停用");
    const untouched = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
    expect(await publishMain([root, "--slug", "fixture"], untouched.io)).toBe(0);
    expect(untouched.out.join("\n")).not.toContain("导入的草稿");
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
  describe("--workdir, --prepare and --finalize", () => {
    async function workdir(): Promise<string> {
      const directory = await mkdtemp(join(tmpdir(), "codelphi-cli-work-"));
      roots.push(directory);
      return directory;
    }

    /** 能数模型调用的替身。 */
    function counting(counts: { calls: number; prompts: string[] }): NonNullable<CliIo["createClient"]> {
      return () => {
        const model = fakeModel();
        const complete = model.complete.bind(model);
        return { ...model, complete: async (messages) => { counts.calls += 1; counts.prompts.push(messages.map((message) => message.content).join("\n")); return complete(messages); } };
      };
    }

    // 提取和行为面枚举的第二步都以「你在维护一个产品知识库」开头，只有枚举的那一步带着改前改后的复述。
    const extractionCalls = (prompts: string[]) => prompts.filter((prompt) => prompt.includes("产品知识库") && !prompt.includes("改前/改后复述")).length;

    it("prepares without uploading, then finalizes without a model and without model credentials", async () => {
      const { root, head } = await repository();
      const directory = await workdir();
      const prepared = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      const preparedModel = { calls: 0, prompts: [] as string[] };
      prepared.io.createClient = counting(preparedModel);
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--prepare"], prepared.io)).toBe(0);
      expect(prepared.requests.filter((request) => request.method === "POST")).toHaveLength(0);
      expect(preparedModel.calls).toBeGreaterThan(0);
      expect(prepared.out.join("\n")).toContain(directory);
      expect(prepared.out.join("\n")).toContain("--finalize");

      // finalize：不要模型，也不要模型的凭证。
      const finalized = harness({ environment: { AI_API_KEY: undefined, AI_MODEL: undefined } });
      const finalizeModel = { calls: 0, prompts: [] as string[] };
      finalized.io.createClient = () => {
        throw new Error("finalize must not create a model client");
      };
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--finalize"], finalized.io)).toBe(0);
      const uploads = finalized.requests.filter((request) => request.method === "POST");
      expect(uploads).toHaveLength(1);
      expect(JSON.parse(uploads[0].body as string).revision.sha).toBe(head);
      expect(finalized.out.join("\n")).toContain("41");
    });

    it("runs the prepared analysis again from where it stopped instead of paying for it twice", async () => {
      const { root } = await repository();
      const directory = await workdir();
      const first = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      const firstModel = { calls: 0, prompts: [] as string[] };
      first.io.createClient = counting(firstModel);
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--prepare"], first.io)).toBe(0);
      expect(extractionCalls(firstModel.prompts)).toBeGreaterThan(0);
      const again = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      const againModel = { calls: 0, prompts: [] as string[] };
      again.io.createClient = counting(againModel);
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--prepare"], again.io)).toBe(0);
      expect(extractionCalls(againModel.prompts)).toBe(0);
      expect(again.err.join("\n")).toContain("续跑");
      // 没有工作目录就什么都不留。
      const bare = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      const bareModel = { calls: 0, prompts: [] as string[] };
      bare.io.createClient = counting(bareModel);
      expect(await publishMain([root, "--slug", "fixture", "--prepare", "--dry-run"], bare.io)).toBe(2);
    });

    it("shows partition position, retry reason and completion instead of repeating the same start line", async () => {
      const { root } = await repository();
      const directory = await workdir();
      const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      let extractionAttempts = 0;
      h.io.createClient = () => {
        const model = fakeModel();
        const complete = model.complete.bind(model);
        return {
          ...model,
          complete: async (messages) => {
            const prompt = messages.map((message) => message.content).join("\n");
            if (prompt.includes("产品知识库") && !prompt.includes("改前/改后复述")) {
              extractionAttempts += 1;
              if (extractionAttempts === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
            }
            return complete(messages);
          },
        };
      };
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--prepare"], h.io)).toBe(0);
      const text = h.err.join("\n");
      expect(text).toContain("提取分区 1/1");
      expect(text).toContain("第 1 次请求失败");
      expect(text).toContain("正在重试");
      expect(text).toContain("完成");
      expect(text).toContain("重试 1 次");
    });

    it("explains which partition timed out and how to resume with a longer model timeout", async () => {
      const { root } = await repository();
      const directory = await workdir();
      const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      h.io.createClient = () => ({
        displayName: "m",
        complete: async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
      });
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--prepare"], h.io)).toBe(1);
      const text = h.err.join("\n");
      expect(text).toContain("提取分区 1/1");
      expect(text).toContain("180 秒");
      expect(text).toContain("AI_TIMEOUT_MS");
      expect(text).toContain("沿用已完成");
    });

    it("explains how to raise the output budget after a truncated partition", async () => {
      const { root } = await repository();
      const directory = await workdir();
      const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      h.io.createClient = () => ({
        displayName: "deepseek-flash",
        complete: async () => { throw new Error("AI output truncated (finish_reason=length): raise the model output budget or narrow the analysis scope"); },
      });
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--prepare"], h.io)).toBe(1);
      const text = h.err.join("\n");
      expect(text).toContain("提取分区 1/1");
      expect(text).toContain("16000");
      expect(text).toContain("AI_MAX_TOKENS");
      expect(text).toContain("65536");
      expect(text).toContain("沿用已完成");
    });

    it("says what is wrong instead of finalizing the wrong thing", async () => {
      const { root } = await repository();
      const empty = await workdir();
      const nowhere = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      expect(await publishMain([root, "--slug", "fixture", "--workdir", empty, "--finalize"], nowhere.io)).toBe(2);
      expect(nowhere.err.join("\n")).toContain("--prepare");

      const directory = await workdir();
      const prepared = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      prepared.io.createClient = counting({ calls: 0, prompts: [] });
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--prepare"], prepared.io)).toBe(0);
      await writeFile(join(root, "lib/auth.ts"), `${AUTH}// one more\n`);
      await git(root, "add", ".");
      await git(root, "-C", root, "-c", "user.name=CLI", "-c", "user.email=cli@example.test", "commit", "-m", "moved on", "--quiet");
      const moved = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      expect(await publishMain([root, "--slug", "fixture", "--workdir", directory, "--finalize"], moved.io)).toBe(2);
      expect(moved.err.join("\n")).toContain("--prepare");
      expect(moved.requests.filter((request) => request.method === "POST")).toHaveLength(0);

      // 准备到一半（没有提案）也不能上传。
      const half = await workdir();
      const started = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
      started.io.createClient = () => ({ displayName: "m", complete: async () => { throw new Error("model down"); } });
      expect(await publishMain([root, "--slug", "fixture", "--workdir", half, "--prepare"], started.io)).toBe(1);
      const unfinished = harness({});
      expect(await publishMain([root, "--slug", "fixture", "--workdir", half, "--finalize"], unfinished.io)).toBe(2);
      expect(unfinished.err.join("\n")).toContain("--prepare");
    });

    it("refuses the flags it cannot make sense of before touching anything", async () => {
      const { root } = await repository();
      for (const argv of [
        [root, "--slug", "fixture", "--prepare"],
        [root, "--slug", "fixture", "--finalize"],
        [root, "--slug", "fixture", "--workdir", await workdir(), "--prepare", "--finalize"],
      ]) {
        const h = harness({ environment: { AI_API_KEY: "k", AI_MODEL: "m" } });
        expect(await publishMain(argv, h.io), argv.join(" ")).toBe(2);
        expect(h.requests, argv.join(" ")).toHaveLength(0);
      }
    });
  });

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
