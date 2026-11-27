import { execFile } from "node:child_process";
import type { SourceScopeRoot } from "../lib/remote-source-index";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredCompletionClient, StructuredCompletionMessage } from "../lib/llm-client";
import type { ClientProduct } from "../lib/client-publish/server";
import { ClientPublishError, plainSource, produceProposal, sourceTexts, type ProduceOptions } from "../lib/client-publish/produce";
import { loadPreparedPublish } from "../lib/client-publish/run-store";
import { analyzeWithAI } from "../lib/ai";
import { getPartitionedAnalysisSources } from "../lib/remote-analysis";
import { resolveGitSnapshot } from "../lib/snapshot/git-backend";
import { parseUnifiedDiff } from "../lib/client-publish/window";

const exec = promisify(execFile);
const roots: string[] = [];

const AUTH_V1 = [
  "export interface Connection {",
  "  status: string;",
  "}",
  "",
  "export function guard(connection: Connection) {",
  "  if (connection.status !== 'ready') {",
  "    throw new Error('not ready');",
  "  }",
  "  return true;",
  "}",
  "",
  "export function refresh(connection: Connection) {",
  "  return connection.status === 'stale';",
  "}",
].join("\n");
const AUTH_V2 = AUTH_V1.replace("throw new Error('not ready');", "throw new Error('not ready');\n    // retry later");
const README_V1 = "# Fixture\n\nA product.\n";
const README_V2 = "# Fixture\n\nA product, edited.\n";
const BILLING = "export function charge(amount: number) {\n  return amount > 0;\n}\n";

async function git(root: string, ...args: string[]) {
  return (await exec("git", ["-C", root, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } })).stdout.trim();
}

/** 两个提交的仓库：第一个建了登录模块和说明，第二个改了登录（加一行注释）、只改了说明的文字、新增了计费。 */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "codelphi-publish-repo-"));
  roots.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "-C", root, "config", "user.email", "publish@example.test");
  await git(root, "-C", root, "config", "user.name", "Publish Test");
  await mkdir(join(root, "lib"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(join(root, "lib/auth.ts"), AUTH_V1);
  await writeFile(join(root, "README.md"), README_V1);
  await writeFile(join(root, "migrations/001_init.sql"), "CREATE TABLE users (id INT);\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial product");
  const first = await git(root, "rev-parse", "HEAD");
  await writeFile(join(root, "lib/auth.ts"), AUTH_V2);
  await writeFile(join(root, "README.md"), README_V2);
  await writeFile(join(root, "lib/billing.ts"), BILLING);
  await git(root, "add", ".");
  await git(root, "commit", "-m", "add billing");
  const head = await git(root, "rev-parse", "HEAD");
  return { root, first, head };
}

/** 提取出来的账本：两个功能，各带一条场景。第二条场景原样抄了一行源码，隐私扫描必须把它剔掉。 */
function ledger() {
  return {
    product: { description: "A fixture product.", evidence: [{ path: "lib/auth.ts", startLine: 1 }] },
    release: { title: "Fixture", summary: "Fixture" },
    changes: [],
    features: [
      {
        name: "登录",
        summary: "登录守卫",
        scenarios: [
          { reference: "HP-1", context: "已连接", action: "进入", outcome: "放行", category: "happy", evidence: [{ path: "lib/auth.ts", startLine: 5 }] },
          // 这一条抄了源码：命中后整条剔除。
          { reference: "EC-1", context: "未就绪", action: "进入", outcome: "export function refresh(connection: Connection) {\n  return connection.status === 'stale';\n}", category: "edge", evidence: [{ path: "lib/auth.ts", startLine: 13 }] },
        ],
      },
      {
        name: "计费",
        summary: "计费",
        scenarios: [{ reference: "HP-1", context: "有金额", action: "扣款", outcome: "成功", category: "happy", evidence: [{ path: "lib/billing.ts", startLine: 1 }] }],
      },
    ],
  };
}

/** 两个功能都有 HP-1，所以假模型对哪个功能都交这张图（主链要有两步，一步的过不了校验）。 */
const graph = {
  entryNodeIds: ["start"],
  nodes: [
    { id: "start", kind: "start", title: "开始", scenarioRefs: [] },
    { id: "go", kind: "action", title: "进行", scenarioRefs: ["HP-1"] },
    { id: "done", kind: "action", title: "完成", scenarioRefs: ["HP-1"] },
  ],
  edges: [
    { id: "e1", from: "start", to: "go", kind: "sequence", scenarioRefs: ["HP-1"] },
    { id: "e2", from: "go", to: "done", kind: "sequence", scenarioRefs: ["HP-1"] },
  ],
  excludedScenarios: [],
};

/** 按提示词的内容分派答案的假模型：提取、行为面两步、流程图各给固定答案，理解层故意答坏（客户端会退回兜底，不随提案上传）。 */
function fakeModel(ledgerOverride?: ReturnType<typeof ledger>) {
  const prompts: string[] = [];
  const client: StructuredCompletionClient = {
    displayName: "fake-tenant-model",
    async complete(messages: StructuredCompletionMessage[]) {
      const prompt = messages.map((message) => message.content).join("\n");
      prompts.push(prompt);
      // 顺序要紧：提取的提示词里也提到 diff 和 JSON，所以先认提取。
      if (prompt.includes("产品知识库") || prompt.includes("product knowledge base")) return JSON.stringify(ledgerOverride ?? ledger());
      if (prompt.includes("你在向一位不了解此变更的工程师转述")) return JSON.stringify({ files: [] });
      if (prompt.includes("复述与上下文")) return JSON.stringify({ features: [] });
      if (prompt.includes("执行图") || prompt.includes("execution graph")) return JSON.stringify(graph);
      return "not json";
    },
  };
  return { client, prompts };
}

function product(overrides: Partial<ClientProduct> = {}): ClientProduct {
  return { slug: "fixture", name: "Fixture", analysisExecutor: "client", currentVersionId: null, currentRevisionSha: null, repository: null, ...overrides };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const emptyListing = { path: "", entries: [], truncated: false, status: "indexed" as const, metrics: { entryCount: 0, prunedCount: 0 } };
// 假模型的账本要引用规划器交回的那个文件，否则证据清洗会把场景剔光。
const pageLedger = {
  product: { description: "A fixture product.", evidence: [{ path: "apps/web/page.tsx", startLine: 1 }] },
  release: { title: "Fixture", summary: "Fixture" },
  changes: [],
  features: [{ name: "页面", summary: "渲染页面", scenarios: [{ reference: "HP-1", context: "打开", action: "渲染", outcome: "显示", category: "happy", evidence: [{ path: "apps/web/page.tsx", startLine: 1 }] }] }],
};

describe("the product's source roots", () => {
  it("plans only the product's source roots when the server configured them", async () => {
    const { root } = await repository();
    const captured: Array<unknown> = [];
    const recordScopeRoots = (async (request: { scopeRoots?: unknown }) => {
      captured.push(request.scopeRoots);
      const listing = { path: "", entries: [], truncated: false, status: "indexed" as const, metrics: { entryCount: 0, prunedCount: 0 } };
      return {
        partitions: [{ slice: { files: [{ path: "apps/web/page.tsx" }] }, sources: [{ path: "apps/web/page.tsx", content: "1: export const page = 1;" }] }],
        // finalize 只用它枚举实现面算覆盖率：空清单就行。
        index: { scopeRoots: [], listRoot: async () => listing, listDir: async () => listing } as never,
        partitionsCapped: false,
        excluded: [],
      } as unknown as Awaited<ReturnType<NonNullable<ProduceOptions["loadPartitions"]>>>;
    }) as unknown as NonNullable<ProduceOptions["loadPartitions"]>;
    // 和 cli 一样：产品的 sourceRoots 由调用方变成 scopeRoots 选项传进来（lib/client-publish/cli.ts）。
    const run = (sourceRoots?: ReadonlyArray<SourceScopeRoot | string>) => ({
      repositoryRoot: root,
      product: product(),
      ...(sourceRoots?.length ? { scopeRoots: sourceRoots } : {}),
      full: false,
      outputLanguage: "zh-CN" as const,
      client: fakeModel(pageLedger).client,
      provider: "github" as const,
      loadPartitions: recordScopeRoots,
    });
    await produceProposal(run([{ path: "apps/web", role: "web" }]));
    expect(captured[0]).toEqual([{ path: "apps/web", role: "web" }]);
    // 字符串形式的也一样（调用方可能直接给字符串）。
    await produceProposal(run(["apps/web"]));
    expect(captured[1]).toEqual([{ path: "apps/web" }]);
    // 没配置就是整个仓库（工作流的默认：path 为空的共享范围根）。
    await produceProposal(run(undefined));
    expect(captured[2]).toEqual([{ path: "", role: "shared" }]);
  });

  it("starts over when the product's source roots change", async () => {
    const { root } = await repository();
    const workdir = await mkdtemp(join(tmpdir(), "codelphi-publish-work-"));
    roots.push(workdir);
    const onePartition = (async () => {
      return {
        partitions: [{ slice: { files: [{ path: "apps/web/page.tsx" }] }, sources: [{ path: "apps/web/page.tsx", content: "1: export const page = 1;" }] }],
        index: { scopeRoots: [], listRoot: async () => emptyListing, listDir: async () => emptyListing } as never,
        partitionsCapped: false,
        excluded: [],
      } as unknown as Awaited<ReturnType<NonNullable<ProduceOptions["loadPartitions"]>>>;
    }) as unknown as NonNullable<ProduceOptions["loadPartitions"]>;
    const run = (scopeRoots?: ReadonlyArray<SourceScopeRoot>) => ({
      repositoryRoot: root,
      product: product(),
      ...(scopeRoots?.length ? { scopeRoots } : {}),
      full: false,
      outputLanguage: "zh-CN" as const,
      client: fakeModel(pageLedger).client,
      provider: "github" as const,
      workdir,
      loadPartitions: onePartition,
    });
    await produceProposal(run([{ path: "apps/web" }]));
    // 源码根目录换了：做好的分区不能沿用（规划是本地的，每次都重跑；沿用指的是模型工作）。
    const restarted = await produceProposal(run([{ path: "apps/api" }]));
    expect(restarted.reused.partitions).toBe(0);
    // 没换就照常沿用。
    const repeated = await produceProposal(run([{ path: "apps/api" }]));
    expect(repeated.reused.partitions).toBe(1);
  });
});

describe("produceProposal", () => {
  it("produces a sealed baseline on a first publish: the window is the commit's own change, in the same shape the hosted path sees", async () => {
    const { root, head } = await repository();
    const model = fakeModel();
    const result = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: model.client, provider: "github" });
    expect(result.decision).toEqual({ action: "publish", mode: "full", reason: "first", windowFrom: "parent" });
    const proposal = result.proposal!;
    expect(proposal.mode).toBe("full");
    expect(proposal.base).toBeNull();
    // 流程图按功能排好序，几路并发谁先谁后不影响提案的内容；被校验拒掉的是 0 张。
    expect(proposal.flows.map((flow) => flow.featureStableKey)).toEqual([...proposal.flows.map((flow) => flow.featureStableKey)].sort());
    expect(result.flows).toEqual({ generated: 2, rejected: 0 });
    expect(proposal.revision).toMatchObject({ sha: head, title: "add billing", branch: "main" });
    // 没有远端的仓库是纯本地仓库：没有主机名和属主。
    expect(proposal.repository).toMatchObject({ repositoryId: null, provider: "local", host: null, owner: null });
    // 第二个提交改了三个文件：登录加了注释（不是行为变更）、说明只改文字（文档）、计费是新增。
    expect(proposal.window!.files.map((file) => [file.path, file.status, file.behavioral])).toEqual([
      ["README.md", "modified", false],
      ["lib/auth.ts", "modified", false],
      ["lib/billing.ts", "added", true],
    ]);
    // 文档不在分析目标里（lib/analysis-target.ts）：不进已分析路径，带着原因列进跳过的那一份。
    expect(proposal.window!.analyzedPaths).toEqual(["lib/auth.ts", "lib/billing.ts"]);
    expect(proposal.window!.skipped).toEqual([{ path: "README.md", reason: "doc" }]);
    // 行为面枚举只针对含行为变更的文件，这里只有计费。
    expect(model.prompts.some((prompt) => prompt.includes("你在向一位不了解此变更的工程师转述"))).toBe(true);
    expect(model.prompts.find((prompt) => prompt.includes("你在向一位不了解此变更的工程师转述"))).toContain("lib/billing.ts");
    expect(model.prompts.find((prompt) => prompt.includes("你在向一位不了解此变更的工程师转述"))).not.toContain("lib/auth.ts");
    // 抄了源码的那条场景被剔掉，其余都在；命中的内容不在提案里。
    expect(result.pruned.map((hit) => hit.path)).toEqual(["proposal.features[0].scenarios[1].outcome"]);
    expect(proposal.proposal.features[0].scenarios.map((scenario) => scenario.reference)).toEqual(["HP-1"]);
    expect(JSON.stringify(proposal)).not.toContain("export function refresh(connection: Connection) {");
    // 理解层没通过校验，客户端退回兜底：兜底不随提案上传。
    expect(proposal.presentation).toBeNull();
    expect(proposal.flows.map((flow) => flow.featureStableKey)).toEqual(["登录", "计费"]);
    expect(proposal.client).toMatchObject({ promptVersion: expect.stringMatching(/^\d{4}-\d{2}-\d{2}\.\d+$/), model: "fake-tenant-model" });
    expect(proposal.coverage).toMatchObject({ implFilesAssembled: expect.any(Number), implFilesTotal: expect.any(Number) });
    expect(proposal.coverage).not.toHaveProperty("coverageRatio");
    // 每个发给模型的提示词都带了「不输出源码」的约束。
    expect(model.prompts.length).toBeGreaterThan(0);
    expect(model.prompts.every((prompt) => prompt.includes("不得出现源码") || prompt.includes("Never reproduce source code"))).toBe(true);
  });

  it("orders the flow graphs by feature however the concurrent generation happens to finish", async () => {
    const { root } = await repository();
    const model = fakeModel();
    const complete = model.client.complete.bind(model.client);
    let delayed = false;
    // 让「登录」那张图晚到：完成的先后是 计费、登录，和按功能排好的顺序（登 在 计 之前）相反。
    model.client.complete = async (messages) => {
      const prompt = messages.map((message) => message.content).join("\n");
      if (prompt.includes("执行图") && prompt.includes("登录守卫")) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return complete(messages);
    };
    const result = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: model.client });
    expect(delayed).toBe(true);
    expect(result.flows).toEqual({ generated: 2, rejected: 0 });
    const keys = result.proposal!.flows.map((flow) => flow.featureStableKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual([...keys].sort());
  });

  it("logs the validation code for every skipped flow graph", async () => {
    const { root } = await repository();
    const model = fakeModel();
    const complete = model.client.complete.bind(model.client);
    const invalid = structuredClone(graph);
    invalid.nodes[1].scenarioRefs = ["HP-404"];
    model.client.complete = async (messages) => {
      const prompt = messages.map((message) => message.content).join("\n");
      if (prompt.includes("执行图") && prompt.includes("登录守卫")) return JSON.stringify(invalid);
      return complete(messages);
    };
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: model.client });
      expect(result.flows).toEqual({ generated: 1, rejected: 1 });
      const logged = warning.mock.calls.map((call) => call.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join(" ")).join("\n");
      expect(logged).toContain("flow graph skipped");
      expect(logged).toContain("登录");
      expect(logged).toContain("UNKNOWN_SCENARIO_REFERENCE");
    } finally {
      warning.mockRestore();
    }
  });

  it("does not call the model at all when the ledger already sits on the target commit", async () => {
    const { root, head } = await repository();
    const model = fakeModel();
    const result = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: head }), full: false, outputLanguage: "zh-CN", client: model.client });
    expect(result.decision).toEqual({ action: "noop", reason: "already_published" });
    expect(result.proposal).toBeUndefined();
    expect(model.prompts).toEqual([]);
  });

  it("asks for a full analysis when the ledger commit is an ancestor and the user did not force one", async () => {
    const { root, first } = await repository();
    const model = fakeModel();
    const result = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: first }), full: false, outputLanguage: "zh-CN", client: model.client });
    expect(result.decision).toEqual({ action: "refuse", reason: "incremental_not_available" });
    expect(model.prompts).toEqual([]);
  });

  it("publishes on top of the base when forced, and the window is the diff from the ledger's commit", async () => {
    const { root, first, head } = await repository();
    const model = fakeModel();
    const result = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: first }), full: true, outputLanguage: "zh-CN", client: model.client });
    expect(result.decision).toEqual({ action: "publish", mode: "full", reason: "forced", windowFrom: "base" });
    expect(result.proposal!.base).toEqual({ specVersionId: 12, sha: first });
    expect(result.proposal!.window!.files.map((file) => file.path)).toEqual(["README.md", "lib/auth.ts", "lib/billing.ts"]);
  });

  it("refuses when the ledger is ahead of the local commit", async () => {
    const { root, first, head } = await repository();
    const model = fakeModel();
    // 本地停在第一个提交，账本已经记到第二个：不发布，也不调模型。
    await git(root, "checkout", "--quiet", first);
    const result = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: head }), full: true, outputLanguage: "zh-CN", client: model.client });
    expect(result.decision).toEqual({ action: "refuse", reason: "ledger_ahead" });
    expect(model.prompts).toEqual([]);
  });

  it("publishes the target's own window after confirming a ledger commit unknown to the local repository", async () => {
    const { root, head } = await repository();
    const unforcedModel = fakeModel();
    const unforced = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: "f".repeat(40) }), full: false, outputLanguage: "zh-CN", client: unforcedModel.client });
    expect(unforced.decision).toEqual({ action: "refuse", reason: "ledger_commit_missing" });
    expect(unforcedModel.prompts).toEqual([]);

    const forced = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: "f".repeat(40) }), full: true, outputLanguage: "zh-CN", client: fakeModel().client });
    expect(forced.decision).toEqual({ action: "publish", mode: "full", reason: "diverged_with_full", windowFrom: "parent" });
    expect(forced.proposal!.base).toEqual({ specVersionId: 12, sha: "f".repeat(40) });
    expect(forced.proposal!.revision.sha).toBe(head);
    expect(forced.proposal!.window!.files.map((file) => file.path)).toEqual(["README.md", "lib/auth.ts", "lib/billing.ts"]);
  });

  it("publishes a full analysis over an unrelated history only when forced", async () => {
    const { root, head } = await repository();
    const model = fakeModel();
    // 另一条历史：同一个仓库里再建一个和 head 互不为祖先的提交。
    await git(root, "checkout", "--quiet", "--orphan", "other");
    await writeFile(join(root, "lib/auth.ts"), AUTH_V1);
    await git(root, "add", ".");
    await git(root, "-C", root, "commit", "-m", "other history");
    const unforced = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: head }), full: false, outputLanguage: "zh-CN", client: model.client });
    expect(unforced.decision).toEqual({ action: "refuse", reason: "needs_full_flag" });
    expect(model.prompts).toEqual([]);
    const forced = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 12, currentRevisionSha: head }), full: true, outputLanguage: "zh-CN", client: model.client });
    expect(forced.decision).toEqual({ action: "publish", mode: "full", reason: "diverged_with_full", windowFrom: "base" });
    expect(forced.proposal!.base).toEqual({ specVersionId: 12, sha: head });
  });

  it("uses the server's binding when the product already has a repository", async () => {
    const { root } = await repository();
    const bound = product({ repository: { repositoryId: 57, provider: "gitlab", host: "gitlab.corp.com", owner: "team", name: "api" } });
    const result = await produceProposal({ repositoryRoot: root, product: bound, full: false, outputLanguage: "zh-CN", client: fakeModel().client });
    expect(result.proposal!.repository).toEqual({ repositoryId: 57, provider: "gitlab", host: "gitlab.corp.com", owner: "team", name: "api" });
  });

  it("fills a missing host on the server's binding from the origin remote", async () => {
    const { root } = await repository();
    await git(root, "remote", "add", "origin", "https://github.com/acme/api.git");
    const bound = product({ repository: { repositoryId: 57, provider: "github", host: null, owner: "acme", name: "api" } });
    const result = await produceProposal({ repositoryRoot: root, product: bound, full: false, outputLanguage: "zh-CN", client: fakeModel().client });
    expect(result.proposal!.repository).toEqual({ repositoryId: 57, provider: "github", host: "github.com", owner: "acme", name: "api" });
  });

  it("takes the repository identity from the origin remote and lets the caller correct the provider", async () => {
    const { root } = await repository();
    await git(root, "remote", "add", "origin", "https://x-access-token:ghs_secretToken@github.com/acme/api.git");
    const result = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: fakeModel().client });
    expect(result.proposal!.repository).toEqual({ repositoryId: null, provider: "github", host: "github.com", owner: "acme", name: "api" });
    expect(JSON.stringify(result.proposal)).not.toContain("ghs_secretToken");
    const overridden = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: fakeModel().client, provider: "gitea" });
    expect(overridden.proposal!.repository).toMatchObject({ provider: "gitea" });
  });

  it("stops instead of publishing when a hit sits in a field the ledger needs", async () => {
    const { root } = await repository();
    const leaked = ledger();
    leaked.release.summary = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const model = fakeModel(leaked);
    const attempt = produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: model.client });
    await expect(attempt).rejects.toBeInstanceOf(ClientPublishError);
    await expect(attempt).rejects.toMatchObject({ code: "privacy_hit_in_required_field" });
  });

  it("reads only committed content: a dirty working tree does not change what is analysed", async () => {
    const { root } = await repository();
    await writeFile(join(root, "lib/billing.ts"), "export function charge() { return false; }\n");
    const result = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: fakeModel().client });
    expect(result.decision.action).toBe("publish");
    expect(result.dirty).toBe(true);
  });

  it("reports progress for each stage", async () => {
    const { root } = await repository();
    const stages: string[] = [];
    await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: fakeModel().client, onProgress: (event) => stages.push(event.stage) });
    for (const stage of ["plan", "partition", "presentation", "window", "enumerate", "flows", "scan"]) expect(stages, stage).toContain(stage);
  });
});

/** 把规划好的每个分区再按文件拆开，好让「做到一半」落在分区之间。 */
const oneFilePerPartition: NonNullable<ProduceOptions["loadPartitions"]> = async (request, runtime, options) => {
  const planned = await getPartitionedAnalysisSources(request, runtime, options);
  return { ...planned, partitions: planned.partitions.flatMap((partition) => partition.sources.map((source) => ({ ...partition, sources: [source] }))) };
};

const isExtraction = (prompt: string) => prompt.includes("产品知识库") || prompt.includes("product knowledge base");

describe("publish --workdir: resume", () => {
  it("does not call the model again for work that finished before an interruption", async () => {
    const { root, head } = await repository();
    const workdir = await mkdtemp(join(tmpdir(), "codelphi-publish-work-"));
    roots.push(workdir);
    const { repoRoot } = await resolveGitSnapshot(root);
    // 分区提取是经 analyze 这一个入口调模型的，数它最准（理解层的提示词里也会出现同样的字样）。
    const extracted: string[][] = [];
    const analyze: typeof analyzeWithAI = async (sources, change, context) => {
      extracted.push(sources.map((source) => source.path));
      return analyzeWithAI(sources, change, context);
    };
    const run = (client: StructuredCompletionClient) => ({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN" as const, client, provider: "github" as const, workdir, loadPartitions: oneFilePerPartition, analyze });

    // 第一次：第一个分区做完，第二个分区的提取一直失败，整次中止。
    const broken = fakeModel();
    const answer = broken.client.complete.bind(broken.client);
    const answered = new Set<string>();
    let failures = 0;
    broken.client.complete = async (messages) => {
      const prompt = messages.map((message) => message.content).join("\n");
      if (isExtraction(prompt) && [...answered].some((done) => done !== prompt)) {
        failures += 1;
        throw new Error("model unavailable");
      }
      const reply = await answer(messages);
      if (isExtraction(prompt)) answered.add(prompt);
      return reply;
    };
    await expect(produceProposal(run(broken.client))).rejects.toThrow();
    expect(failures).toBeGreaterThanOrEqual(1);
    expect(answered.size).toBe(1);

    // 第二次：模型恢复了。做过的那个分区不再调模型。
    extracted.length = 0;
    const model = fakeModel();
    const resumed = await produceProposal(run(model.client));
    expect(extracted).toHaveLength(1);
    expect(resumed.reused.partitions).toBe(1);
    expect(resumed.proposal!.revision.sha).toBe(head);

    // 第三次：分区、行为面枚举、流程图都是现成的；理解层故意答坏，所以每次都重做。提案和上一次一字不差。
    const again = fakeModel();
    extracted.length = 0;
    const repeated = await produceProposal(run(again.client));
    expect(extracted).toHaveLength(0);
    expect(again.prompts.filter((prompt) => prompt.includes("执行图"))).toHaveLength(0);
    expect(again.prompts.filter((prompt) => prompt.includes("你在向一位不了解此变更的工程师转述"))).toHaveLength(0);
    expect(again.prompts).toHaveLength(1);
    expect(repeated.reused).toEqual({ partitions: 2, flows: 2, enumeration: true, presentation: false });
    expect(repeated.proposal!.proposalHash).toBe(resumed.proposal!.proposalHash);

    // --finalize 读到的就是它。
    const prepared = await loadPreparedPublish(workdir, { repositoryRoot: repoRoot, productSlug: "fixture", targetSha: head });
    expect(prepared.proposal.proposalHash).toBe(resumed.proposal!.proposalHash);
    expect(prepared.summary).toEqual({ decision: resumed.decision, repository: resumed.repository, dirty: resumed.dirty, pruned: resumed.pruned, flows: resumed.flows, enumeration: resumed.enumeration, reused: repeated.reused, startedAt: repeated.startedAt });
  });

  it("starts over when the model changes, and keeps nothing when no work directory is given", async () => {
    const { root } = await repository();
    const workdir = await mkdtemp(join(tmpdir(), "codelphi-publish-work-"));
    roots.push(workdir);
    await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: fakeModel().client, provider: "github", workdir, loadPartitions: oneFilePerPartition });
    const other = fakeModel();
    other.client.displayName = "another-tenant-model";
    const restarted = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: other.client, provider: "github", workdir, loadPartitions: oneFilePerPartition });
    expect(other.prompts.filter((prompt) => prompt.includes("执行图")).length).toBeGreaterThan(0);
    expect(restarted.reused).toEqual({ partitions: 0, flows: 0, enumeration: false, presentation: false });

    const fresh = fakeModel();
    const single = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: fresh.client, provider: "github", loadPartitions: oneFilePerPartition });
    expect(single.reused).toEqual({ partitions: 0, flows: 0, enumeration: false, presentation: false });
    expect(fresh.prompts.filter((prompt) => prompt.includes("执行图")).length).toBeGreaterThan(0);
  });

  it("does not open a work directory at all when there is nothing to publish", async () => {
    const { root, head } = await repository();
    const workdir = await mkdtemp(join(tmpdir(), "codelphi-publish-work-"));
    roots.push(workdir);
    const model = fakeModel();
    const noop = await produceProposal({ repositoryRoot: root, product: product({ currentVersionId: 3, currentRevisionSha: head }), full: false, outputLanguage: "zh-CN", client: model.client, provider: "github", workdir });
    expect(noop.decision.action).toBe("noop");
    expect(model.prompts).toHaveLength(0);
    await expect(loadPreparedPublish(workdir, { repositoryRoot: root, productSlug: "fixture", targetSha: head })).rejects.toMatchObject({ code: "publish_not_prepared" });
  });
});

describe("the source index the privacy scan compares against", () => {
  it("strips the line numbers the model saw, and leaves content that was never numbered alone", () => {
    expect(plainSource("1: export const a = 1;\n2: export const b = 2;\n3: \n4: export const c = 3;\n")).toBe("export const a = 1;\nexport const b = 2;\n\nexport const c = 3;\n");
    // 一半以上的非空行带行号才算带行号的源码；行里的「12: 」这种时间写法不一定是行号。
    expect(plainSource("1: first\nnot numbered\nnot numbered either\n")).toBe("1: first\nnot numbered\nnot numbered either\n");
    // 边界：只有一行且带行号；恰好一半带行号。都算带行号的源码。
    expect(plainSource("1: export const a = 1;\n")).toBe("export const a = 1;\n");
    expect(plainSource("1: numbered\nplain\n")).toBe("numbered\nplain\n");
    expect(plainSource("")).toBe("");
    expect(plainSource("const only = 1;\n")).toBe("const only = 1;\n");
  });

  it("covers every file the analysis read: each partition source without its numbers, plus the window's files that no partition read", async () => {
    const { root, first } = await repository();
    // 窗口里再加一个二进制文件：不进索引。
    await writeFile(join(root, "lib/blob.bin"), "abc\0def\n");
    await git(root, "add", ".");
    await git(root, "commit", "-m", "add a blob");
    const final = await git(root, "rev-parse", "HEAD");
    // 从计费出现之前的那个提交比起，窗口里就有新加的计费文件、改过的说明和那个二进制文件。
    const diff = await git(root, "diff", "--no-color", "-M", "--unified=0", first, final);
    const files = [...parseUnifiedDiff(diff), { path: "lib/removed.ts", status: "removed" as const, previousPath: null, patch: "" }];
    const texts = await sourceTexts(root, { partitions: [{ slice: {} as never, sources: [{ path: "lib/auth.ts", content: `1: ${AUTH_V2.split("\n")[0]}\n2: ${AUTH_V2.split("\n")[1]}\n` }] }] }, files, final);
    const byPath = new Map(texts.map((text) => [text.path, text.text]));
    expect([...byPath.keys()].sort()).toEqual(["README.md", "lib/auth.ts", "lib/billing.ts"]);
    // 窗口里的说明文件原样进来。
    expect(byPath.get("README.md")).toBe(README_V2);
    // 分区里的那份已经去掉行号。
    expect(byPath.get("lib/auth.ts")).toBe(`${AUTH_V2.split("\n")[0]}\n${AUTH_V2.split("\n")[1]}\n`);
    // 窗口里新增的计费文件按目标提交读出来，是原样。
    expect(byPath.get("lib/billing.ts")).toBe(BILLING);
  });
});

describe("a ledger with a single feature", () => {
  it("is a valid analysis, not an empty one", async () => {
    const { root } = await repository();
    const single = ledger();
    single.features = single.features.slice(0, 1);
    single.features[0].scenarios = single.features[0].scenarios.slice(0, 1);
    const result = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: fakeModel(single).client });
    expect(result.proposal!.proposal.features).toHaveLength(1);
    expect(result.flows).toEqual({ generated: 1, rejected: 0 });
  });
});
