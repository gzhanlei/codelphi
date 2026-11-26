import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StructuredCompletionClient, StructuredCompletionMessage } from "../lib/llm-client";
import type { ClientProduct } from "../lib/client-publish/server";
import { ClientPublishError, produceProposal } from "../lib/client-publish/produce";

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

describe("produceProposal", () => {
  it("produces a sealed baseline on a first publish: the window is the commit's own change, in the same shape the hosted path sees", async () => {
    const { root, head } = await repository();
    const model = fakeModel();
    const result = await produceProposal({ repositoryRoot: root, product: product(), full: false, outputLanguage: "zh-CN", client: model.client, provider: "github" });
    expect(result.decision).toEqual({ action: "publish", mode: "full", reason: "first", windowFrom: "parent" });
    const proposal = result.proposal!;
    expect(proposal.mode).toBe("full");
    expect(proposal.base).toBeNull();
    expect(proposal.revision).toMatchObject({ sha: head, title: "add billing", branch: "main" });
    // 没有远端的仓库是纯本地仓库：没有主机名和属主。
    expect(proposal.repository).toMatchObject({ repositoryId: null, provider: "local", host: null, owner: null });
    // 第二个提交改了三个文件：登录加了注释（不是行为变更）、说明只改文字（文档）、计费是新增。
    expect(proposal.window!.files.map((file) => [file.path, file.status, file.behavioral])).toEqual([
      ["README.md", "modified", false],
      ["lib/auth.ts", "modified", false],
      ["lib/billing.ts", "added", true],
    ]);
    expect(proposal.window!.analyzedPaths).toEqual(["README.md", "lib/auth.ts", "lib/billing.ts"]);
    expect(proposal.window!.skipped).toEqual([]);
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

  it("refuses when the ledger's commit is unknown to the local repository", async () => {
    const model = fakeModel();
    const other = await mkdtemp(join(tmpdir(), "codelphi-publish-other-"));
    roots.push(other);
    await git(other, "init", "-b", "main");
    await writeFile(join(other, "a.txt"), "a\n");
    await git(other, "add", ".");
    await git(other, "-C", other, "-c", "user.name=Other", "-c", "user.email=other@example.test", "commit", "-m", "other");
    const result = await produceProposal({ repositoryRoot: other, product: product({ currentVersionId: 12, currentRevisionSha: "f".repeat(40) }), full: true, outputLanguage: "zh-CN", client: model.client });
    expect(result.decision).toEqual({ action: "refuse", reason: "ledger_commit_missing" });
    expect(model.prompts).toEqual([]);
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
