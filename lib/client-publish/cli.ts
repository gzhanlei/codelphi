/**
 * 客户端分析的三个命令：config（接入）、status（看绑定和账本位置）、publish（判定、分析、扫描、上传）。
 * 命令逻辑都在这里，scripts/snapshot.ts 只做分发；输入输出全部经过 CliIo，所以不启动进程就能测。
 *
 * Key 的安全贯穿在这里：问 Key 时不回显；保存前告诉用户请求发到哪里；任何输出里都不出现 Key。
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { StructuredCompletionClient } from "../llm-client";
import { createStandaloneClientFromEnv } from "../llm-client";
import { runGit } from "../snapshot/git";
import { resolveGitSnapshot } from "../snapshot/git-backend";
import { basename } from "node:path";
import type { RepositoryIdentity } from "../client-proposal/contract";
import { CREDENTIAL_KEYS, credentialsPath, DEFAULT_SERVER_URL, describeConfig, readCredentials, resolveConfig, writeCredentials } from "./credentials";
import { ClientPublishError, produceProposal } from "./produce";
import { repositoryIdentityOf } from "./identity";
import { REFUSAL_TEXT } from "./state";
import { fetchContext, ServerRequestError, uploadProposal, type ClientContext, type ClientProduct } from "./server";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
  environment: Record<string, string | undefined>;
  /** 问用户一个问题。secret 为 true 时不回显。 */
  ask?(prompt: string, options?: { secret?: boolean }): Promise<string>;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** 凭证文件的位置。缺省按平台 conventions 放在用户配置目录下。 */
  credentialsFile?: string;
  /** 造模型客户端。缺省按配置里的 AI_* 建一个 OpenAI 兼容客户端。 */
  createClient?(environment: Record<string, string | undefined>): StructuredCompletionClient;
  /** 从标准输入读一段内容（--value-stdin 用）。 */
  readStdin?(): Promise<string>;
}

type Language = "zh-CN" | "en";
type Text = { zh: string; en: string };

const say = (text: Text, language: Language): string => (language === "en" ? text.en : text.zh);

function languageOf(argv: readonly string[]): Language {
  const index = argv.indexOf("--language");
  return index >= 0 && argv[index + 1] === "en" ? "en" : "zh-CN";
}

const MODEL_KEYS = ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL"];
const SERVER_KEYS = ["CODELPHI_SERVER_URL", "CODELPHI_SNAPSHOT_KEY"];
/** 模型服务地址不填时的默认值。OpenAI 兼容接口的通行写法；用别家的服务就自己填（我的默认）。 */
export const DEFAULT_MODEL_BASE_URL = "https://api.openai.com/v1";
/** 这个客户端说的提案契约版本。服务端不再接受它时，用户得升级客户端。 */
export const CLIENT_CONTRACT_VERSION = "2.0.0";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadConfig(io: CliIo, file: string): Promise<Record<string, string | undefined>> {
  return readCredentials(file).then((credentials) => resolveConfig({ process: io.environment, credentials }));
}

// ───────────────────────────── config ─────────────────────────────

/** 验证上传 key：调上下文接口，拿回组织名和产品数。失败时返回可以给用户看的说明，里面不含 key。 */
export async function verifyServer(config: Record<string, string | undefined>, fetchImpl?: CliIo["fetchImpl"]): Promise<{ ok: true; organization: string; clientProducts: number } | { ok: false; message: string }> {
  if (!config.CODELPHI_SNAPSHOT_KEY) return { ok: false, message: "missing upload key" };
  try {
    const context = await fetchContext({ serverUrl: config.CODELPHI_SERVER_URL ?? DEFAULT_SERVER_URL, key: config.CODELPHI_SNAPSHOT_KEY }, fetchImpl ?? fetch);
    return { ok: true, organization: context.organization.name, clientProducts: context.products.filter((product) => product.analysisExecutor === "client").length };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

/** 验证模型配置：发一个最小的工作单，答案必须是解析得出来的 JSON。只测网络通不算。 */
export async function verifyModel(config: Record<string, string | undefined>, createClient?: CliIo["createClient"]): Promise<{ ok: true; model: string } | { ok: false; message: string }> {
  try {
    const client = (createClient ?? createStandaloneClientFromEnv)(config);
    const content = await client.complete([{ role: "user", content: 'Reply with exactly this JSON object and nothing else: {"ok":true}' }]);
    if (!/"ok"\s*:\s*true/.test(content)) return { ok: false, message: "the model did not return the expected JSON" };
    return { ok: true, model: client.displayName ?? config.AI_MODEL ?? "" };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function printDescribe(io: CliIo, config: Record<string, string | undefined>, language: Language): void {
  const described = describeConfig(config);
  for (const key of CREDENTIAL_KEYS) {
    const item = described[key as keyof typeof described];
    if (item.state === "missing") io.stdout(`${key}: ${say({ zh: "未设置", en: "not set" }, language)}`);
    else io.stdout(`${key}: ${say({ zh: "已设置", en: "set" }, language)}${"value" in item ? `（${item.value}）` : ""}`);
  }
}

const CONFIG_USAGE: Text = {
  zh: "用法：config [--set 项=值 …] [--value-stdin] [--no-verify] | --show | --reset",
  en: "Usage: config [--set KEY=VALUE ...] [--value-stdin] [--no-verify] | --show | --reset",
};

export async function configMain(argv: string[], io: CliIo): Promise<number> {
  const language = languageOf(argv);
  const t = (text: Text) => say(text, language);
  try {
    const { values } = parseArgs({
      args: argv.filter((argument, index) => argument !== "--language" && argv[index - 1] !== "--language"),
      allowPositionals: false,
      options: {
        show: { type: "boolean", default: false },
        reset: { type: "boolean", default: false },
        set: { type: "string", multiple: true },
        "value-stdin": { type: "boolean", default: false },
        "no-verify": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
    if (values.help) {
      io.stdout(t(CONFIG_USAGE));
      return 0;
    }
    const file = io.credentialsFile ?? credentialsPath({ env: io.environment });
    if (values.reset) {
      const { rm } = await import("node:fs/promises");
      await rm(file, { force: true });
      io.stdout(t({ zh: `已删除 ${file}`, en: `Removed ${file}` }));
      return 0;
    }
    const stored = await readCredentials(file);
    if (values.show) {
      printDescribe(io, resolveConfig({ process: io.environment, credentials: stored }), language);
      return 0;
    }

    let updates: Record<string, string>;
    if (values.set && values.set.length > 0) {
      updates = {};
      for (const item of values.set) {
        const equals = item.indexOf("=");
        const key = (equals < 0 ? item : item.slice(0, equals)).trim();
        if (!(CREDENTIAL_KEYS as readonly string[]).includes(key)) {
          io.stderr(`${key}: ${t({ zh: "不是可以配置的项。", en: "is not a configurable key." })}\n${t(CONFIG_USAGE)}`);
          return 2;
        }
        // `--set KEY`（不带等号）配合 --value-stdin：值从标准输入读，Key 不留在 shell 历史里。
        updates[key] = equals >= 0 ? item.slice(equals + 1) : values["value-stdin"] && io.readStdin ? (await io.readStdin()).trim() : "";
      }
    } else {
      // 接入向导：先告诉用户请求发到哪里，再逐项问。
      const serverUrl = stored.CODELPHI_SERVER_URL || io.environment.CODELPHI_SERVER_URL || DEFAULT_SERVER_URL;
      const modelBase = stored.AI_BASE_URL || io.environment.AI_BASE_URL || DEFAULT_MODEL_BASE_URL;
      io.stdout(t({ zh: `模型请求将发送到 ${modelBase}，不经过 CoDelphi 服务端。`, en: `Model requests go to ${modelBase}; they do not pass through the CoDelphi server.` }));
      io.stdout(t({ zh: `分析提案将上传到 ${serverUrl}，内容不含源码文件和补丁。`, en: `Analysis proposals are uploaded to ${serverUrl}; they contain no source files or patches.` }));
      updates = {};
      const ask = async (prompt: string, options?: { secret?: boolean }): Promise<string> => (io.ask ? io.ask(prompt, options) : "");
      const keep = (key: string, fallback: string) => stored[key] ?? io.environment[key] ?? fallback;
      const answer = await ask(t({ zh: `服务地址 [${serverUrl}]: `, en: `Server address [${serverUrl}]: ` }));
      if (answer.trim()) updates.CODELPHI_SERVER_URL = answer.trim();
      const uploadKey = await ask(t({ zh: "上传 key: ", en: "Upload key: " }), { secret: true });
      if (uploadKey.trim()) updates.CODELPHI_SNAPSHOT_KEY = uploadKey.trim();
      else if (!keep("CODELPHI_SNAPSHOT_KEY", "")) {
        io.stderr(t({ zh: "没有上传 key 就无法发布。请先在 CoDelphi 的设置页创建一把 snapshot_write 权限的 key。", en: "Publishing needs an upload key. Create a snapshot_write key in your CoDelphi settings first." }));
        return 2;
      }
      const modelAnswer = await ask(t({ zh: `模型服务地址 [${stored.AI_BASE_URL || io.environment.AI_BASE_URL || DEFAULT_MODEL_BASE_URL}]: `, en: `Model service address [${stored.AI_BASE_URL || io.environment.AI_BASE_URL || DEFAULT_MODEL_BASE_URL}]: ` }));
      if (modelAnswer.trim()) updates.AI_BASE_URL = modelAnswer.trim();
      const modelKey = await ask(t({ zh: "API Key: ", en: "API Key: " }), { secret: true });
      if (modelKey.trim()) updates.AI_API_KEY = modelKey.trim();
      const model = await ask(stored.AI_MODEL || io.environment.AI_MODEL ? t({ zh: `模型名 [${stored.AI_MODEL || io.environment.AI_MODEL}]: `, en: `Model [${stored.AI_MODEL || io.environment.AI_MODEL}]: ` }) : t({ zh: "模型名: ", en: "Model: " }));
      if (model.trim()) updates.AI_MODEL = model.trim();
    }
    if (Object.keys(updates).length === 0) {
      io.stdout(t({ zh: "没有改动。", en: "Nothing to change." }));
      return 0;
    }
    if (!values["no-verify"]) {
      const next = resolveConfig({ process: io.environment, credentials: { ...stored, ...updates } });
      if (Object.keys(updates).some((key) => SERVER_KEYS.includes(key))) {
        const outcome = await verifyServer(next, io.fetchImpl);
        if (!outcome.ok) {
          io.stderr(t({ zh: `上传 key 没有通过验证：${outcome.message}。没有保存。`, en: `The upload key could not be verified: ${outcome.message}. Nothing was saved.` }));
          return 1;
        }
        io.stdout(t({ zh: `已连接到 ${outcome.organization}（${outcome.clientProducts} 个产品由客户端分析）。`, en: `Connected to ${outcome.organization} (${outcome.clientProducts} products analysed by the client).` }));
      }
      if (Object.keys(updates).some((key) => MODEL_KEYS.includes(key))) {
        const outcome = await verifyModel(next, io.createClient);
        if (!outcome.ok) {
          io.stderr(t({ zh: `模型没有通过验证：${outcome.message}。没有保存。`, en: `The model could not be verified: ${outcome.message}. Nothing was saved.` }));
          return 1;
        }
        io.stdout(t({ zh: `模型可用：${outcome.model}。`, en: `Model reachable: ${outcome.model}.` }));
      }
    }
    await writeCredentials(file, updates);
    io.stdout(t({ zh: `已保存到 ${file}`, en: `Saved to ${file}` }));
    return 0;
  } catch (error) {
    io.stderr(errorMessage(error));
    return 1;
  }
}

// ───────────────────────────── 产品选择 ─────────────────────────────

/** 按 --slug 找产品；没给 --slug 时，只有恰好一个由客户端分析的产品才用它。找不到时返回可以给用户看的原因。 */
export function selectProduct(context: ClientContext, slug: string | undefined): { product: ClientProduct } | { message: Text } {
  if (slug) {
    const product = context.products.find((item) => item.slug === slug);
    if (!product) return { message: { zh: `这个组织里没有叫「${slug}」的产品。`, en: `This organization has no product named "${slug}".` } };
    if (product.analysisExecutor !== "client") {
      return { message: { zh: `产品「${product.name}」由服务端分析。客户端分析是受控试点，要等运营为它开启之后才能发布。`, en: `"${product.name}" is analysed on the server. Client analysis is a controlled pilot: it has to be enabled for this product first.` } };
    }
    return { product };
  }
  const candidates = context.products.filter((item) => item.analysisExecutor === "client");
  if (candidates.length === 1) return { product: candidates[0] };
  if (candidates.length === 0) return { message: { zh: "这个组织里还没有由客户端分析的产品。", en: "No product of this organization is analysed by the client yet." } };
  return { message: { zh: `有 ${candidates.length} 个产品由客户端分析，请用 --slug 指定：${candidates.map((item) => item.slug).join("、")}`, en: `${candidates.length} products are analysed by the client; pass --slug: ${candidates.map((item) => item.slug).join(", ")}` } };
}

async function originRemote(repositoryRoot: string): Promise<string | null> {
  try {
    return (await runGit(["-C", repositoryRoot, "remote", "get-url", "origin"])).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

function describeRepository(identity: RepositoryIdentity, language: Language): string {
  if (identity.provider === "local") return say({ zh: "纯本地仓库（没有远端），按产品绑定", en: "local repository (no remote), bound to the product" }, language);
  return `${identity.host}/${identity.owner ?? ""}/${identity.name}（${identity.provider}）`;
}

// ───────────────────────────── status ─────────────────────────────

export async function statusMain(argv: string[], io: CliIo): Promise<number> {
  const language = languageOf(argv);
  const t = (text: Text) => say(text, language);
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { slug: { type: "string" }, provider: { type: "string" } } }) as { values: { slug?: string; provider?: string }; positionals: string[] };
    const file = io.credentialsFile ?? credentialsPath({ env: io.environment });
    const config = await loadConfig(io, file);
    printDescribe(io, config, language);
    if (positionals.length !== 1) {
      io.stderr(t({ zh: "用法：status <本地仓库路径> [--slug <产品别名>]", en: "Usage: status <local repository> [--slug <product>]" }));
      return 2;
    }
    const snapshot = await resolveGitSnapshot(positionals[0]);
    const remote = await originRemote(snapshot.repoRoot);
    const identity = repositoryIdentityOf(remote, basename(snapshot.repoRoot), values.provider ? { provider: values.provider as RepositoryIdentity["provider"] } : {});
    io.stdout(t({ zh: `绑定：${describeRepository(identity, language)}`, en: `Binding: ${describeRepository(identity, language)}` }));
    io.stdout(t({ zh: `本地提交：${snapshot.revision.slice(0, 12)}${snapshot.workingTreeDirty ? "（工作区有未提交的改动）" : ""}`, en: `Local commit: ${snapshot.revision.slice(0, 12)}${snapshot.workingTreeDirty ? " (uncommitted changes in the working tree)" : ""}` }));
    if (!config.CODELPHI_SNAPSHOT_KEY) return 0;
    const context = await fetchContext({ serverUrl: config.CODELPHI_SERVER_URL ?? DEFAULT_SERVER_URL, key: config.CODELPHI_SNAPSHOT_KEY }, io.fetchImpl);
    const selected = selectProduct(context, values.slug);
    if ("message" in selected) {
      io.stderr(t(selected.message));
      return 2;
    }
    const product = selected.product;
    if (product.repository) io.stdout(t({ zh: `服务端绑定：仓库 #${product.repository.repositoryId}`, en: `Server binding: repository #${product.repository.repositoryId}` }));
    if (product.currentRevisionSha === null) {
      io.stdout(t({ zh: "账本：还没有版本。下一次发布是首次全量分析。", en: "Ledger: no version yet. The next publish is a first full analysis." }));
    } else {
      io.stdout(t({ zh: `账本：版本 #${product.currentVersionId}，提交 ${product.currentRevisionSha.slice(0, 12)}`, en: `Ledger: version #${product.currentVersionId}, commit ${product.currentRevisionSha.slice(0, 12)}` }));
      io.stdout(t(relationText(snapshot.revision, product.currentRevisionSha)));
    }
    return 0;
  } catch (error) {
    io.stderr(errorMessage(error));
    return 1;
  }
}

function relationText(local: string, ledger: string): Text {
  if (local === ledger) return { zh: "本地提交和账本一致：不带 --full 再发布是空操作。", en: "The local commit matches the ledger: publishing again without --full does nothing." };
  return { zh: `账本落后于本地提交 ${local.slice(0, 12)}：需要带 --full 发布。`, en: `The ledger is behind local commit ${local.slice(0, 12)}: publish with --full.` };
}

// ───────────────────────────── publish ─────────────────────────────

export async function publishMain(argv: string[], io: CliIo): Promise<number> {
  const language = languageOf(argv);
  const t = (text: Text) => say(text, language);
  try {
    const { values, positionals } = parseArgs({
      args: argv.filter((argument, index) => argument !== "--language" && argv[index - 1] !== "--language"),
      allowPositionals: true,
      options: { slug: { type: "string" }, full: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, provider: { type: "string" } },
    }) as { values: { slug?: string; full: boolean; "dry-run": boolean; provider?: string }; positionals: string[] };
    if (positionals.length !== 1) {
      io.stderr(t({ zh: "用法：publish <本地仓库路径> [--slug <产品别名>] [--full] [--dry-run] [--provider <github|gitlab|gitee|gitea>]", en: "Usage: publish <local repository> [--slug <product>] [--full] [--dry-run] [--provider <github|gitlab|gitee|gitea>]" }));
      return 2;
    }
    const config = await loadConfig(io, io.credentialsFile ?? credentialsPath({ env: io.environment }));
    if (!config.AI_API_KEY || !config.AI_MODEL) {
      io.stderr(t({ zh: "缺少模型配置：请先运行 config，填写 AI_API_KEY 与 AI_MODEL。", en: "Model configuration is missing: run config and fill in AI_API_KEY and AI_MODEL." }));
      return 2;
    }
    if (!config.CODELPHI_SNAPSHOT_KEY) {
      io.stderr(t({ zh: "缺少上传 key：请先运行 config，填写 CODELPHI_SNAPSHOT_KEY。", en: "Upload key is missing: run config and fill in CODELPHI_SNAPSHOT_KEY." }));
      return 2;
    }
    const server = { serverUrl: config.CODELPHI_SERVER_URL ?? DEFAULT_SERVER_URL, key: config.CODELPHI_SNAPSHOT_KEY };
    let context: ClientContext;
    try {
      context = await fetchContext(server, io.fetchImpl);
    } catch (error) {
      io.stderr(t({ zh: `连不上服务端或上传 key 无效：${errorMessage(error)}`, en: `Could not reach the server, or the upload key was refused: ${errorMessage(error)}` }));
      return 2;
    }
    const selected = selectProduct(context, values.slug);
    if ("message" in selected) {
      io.stderr(t(selected.message));
      return 2;
    }
    // 服务端不再收这个客户端说的契约版本，或者最低支持的版本比它新：都得升级客户端。
    if (!context.supportedContractVersions.includes(CLIENT_CONTRACT_VERSION) || versionGreater(context.minSupportedContractVersion, CLIENT_CONTRACT_VERSION)) {
      io.stderr(t({ zh: `服务端不再接受这个客户端的契约版本（最低 ${context.minSupportedContractVersion}），请升级客户端。`, en: `The server no longer accepts this client's contract version (minimum ${context.minSupportedContractVersion}); upgrade the client.` }));
      return 5;
    }
    const client = (io.createClient ?? createStandaloneClientFromEnv)(config);
    const result = await produceProposal({
      repositoryRoot: positionals[0],
      product: selected.product,
      full: values.full,
      outputLanguage: language,
      client,
      modelName: client.displayName ?? config.AI_MODEL,
      ...(values.provider ? { provider: values.provider as RepositoryIdentity["provider"] } : {}),
      onProgress: (event) => {
        if (event.status === "start") io.stderr(t({ zh: `… ${stageText(event.stage).zh}${"total" in event && event.total ? `（${event.total}）` : ""}`, en: `... ${stageText(event.stage).en}${"total" in event && event.total ? ` (${event.total})` : ""}` }));
      },
    });
    const proposal = result.proposal;
    if (result.decision.action === "refuse") {
      io.stderr(t(REFUSAL_TEXT[result.decision.reason]));
      return 3;
    }
    if (result.decision.action === "noop" || !proposal) {
      io.stdout(t({ zh: "账本已经在这个提交上了，没有可发布的内容。", en: "The ledger already sits on this commit; there is nothing to publish." }));
      return 0;
    }
    if (result.dirty) io.stderr(t({ zh: "工作区有未提交的改动：分析的是已提交的内容，改动不在这次发布里。", en: "The working tree has uncommitted changes: the analysis covers committed content only, so they are not part of this publish." }));
    const features = proposal.proposal.features;
    const scenarios = features.reduce((total, feature) => total + feature.scenarios.length, 0);
    io.stdout(t({ zh: `全量分析：${features.length} 个功能、${scenarios} 条场景；变更窗口 ${proposal.window?.files.length ?? 0} 个文件（其中行为变更 ${proposal.window?.files.filter((file) => file.behavioral).length ?? 0} 个）；流程图 ${result.flows.generated} 张。`, en: `Full analysis: ${features.length} features, ${scenarios} scenarios; change window ${proposal.window?.files.length ?? 0} files (${proposal.window?.files.filter((file) => file.behavioral).length ?? 0} with behavioural changes); ${result.flows.generated} flow graphs.` }));
    for (const feature of features) io.stdout(`  ${feature.name}: ${feature.scenarios.map((scenario) => scenario.reference).join(" ")}`);
    if (result.pruned.length > 0) {
      io.stderr(t({ zh: `隐私扫描剔除了 ${result.pruned.length} 处（看起来像源码的内容不上传）：`, en: `The privacy scan removed ${result.pruned.length} item(s) that looked like source code; they were not uploaded:` }));
      for (const item of result.pruned) io.stderr(`  ${item.path}（${item.rules.join("、")}）`);
    }
    if (values["dry-run"]) {
      io.stdout(t({ zh: `试运行：提案 ${JSON.stringify(proposal).length} 字节，未上传。`, en: `Dry run: the proposal is ${JSON.stringify(proposal).length} bytes; nothing was uploaded.` }));
      return 0;
    }
    const upload = await uploadProposal(server, selected.product.slug, JSON.stringify(proposal), { fetchImpl: io.fetchImpl });
    return reportUpload(upload.status, upload.body, proposal.revision.sha, server, selected.product.slug, io, t);
  } catch (error) {
    if (error instanceof ClientPublishError && error.code === "privacy_hit_in_required_field") {
      io.stderr(t({ zh: "提案的产品简介或发布信息里有看起来像源码的内容，没法自动剔除。请调整后重新分析。", en: "The product description or release information contains text that looks like source code and cannot be removed automatically. Run the analysis again." }));
      return 5;
    }
    io.stderr(t({ zh: `发布失败：${errorMessage(error)}`, en: `Publish failed: ${errorMessage(error)}` }));
    return 1;
  }
}

/** 点分的三段版本号比大小。 */
function versionGreater(left: string, right: string): boolean {
  const parse = (version: string) => version.split(".").map((part) => Number(part) || 0);
  const [a = 0, b = 0, c = 0] = parse(left);
  const [x = 0, y = 0, z = 0] = parse(right);
  return a !== x ? a > x : b !== y ? b > y : c > z;
}

function stageText(stage: string): Text {
  switch (stage) {
    case "plan": return { zh: "规划分区", en: "planning partitions" };
    case "partition": return { zh: "提取", en: "extracting" };
    case "presentation": return { zh: "生成理解层", en: "building the presentation" };
    case "window": return { zh: "读取变更窗口", en: "reading the change window" };
    case "enumerate": return { zh: "行为面枚举", en: "enumerating behaviour" };
    case "flows": return { zh: "生成流程图", en: "generating flow graphs" };
    default: return { zh: "隐私扫描", en: "scanning for source text" };
  }
}

/** 把服务端的回答翻译成给用户看的话和退出码。0 成功或重放；4 基线过期；5 需要升级或被拒收；1 其它。 */
async function reportUpload(status: number, body: Record<string, unknown>, localSha: string, server: { serverUrl: string; key: string }, slug: string, io: CliIo, t: (text: Text) => string): Promise<number> {
  if (status === 200) {
    const replayed = body.replayed === true;
    io.stdout(t({ zh: `${replayed ? "这份提案之前已经发布过，没有产生新版本。" : "已发布。"}产品 ${slug}：版本 #${body.specVersionId}${body.releaseId == null ? "" : `，发布 #${body.releaseId}`}。`, en: `${replayed ? "This proposal had already been published; no new version was created." : "Published."} Product ${slug}: version #${body.specVersionId}${body.releaseId == null ? "" : `, release #${body.releaseId}`}.` }));
    return 0;
  }
  if (status === 409 && body.error === "base_changed") {
    // 分析期间账本前进了。先看现在是不是已经在本地提交上：是的话别人刚发布过，不用再发。
    const context = await fetchContext(server, io.fetchImpl).catch(() => null);
    const now = context?.products.find((product) => product.slug === slug);
    if (now?.currentRevisionSha === localSha) {
      io.stdout(t({ zh: `账本已经在提交 ${localSha.slice(0, 12)} 上了：另一个发布者刚发布过同一个提交，不需要再发。`, en: `The ledger already sits on commit ${localSha.slice(0, 12)}: another publisher just published this very commit; nothing more to do.` }));
      return 0;
    }
    const details = (body.details ?? {}) as { current?: { specVersionId?: number }; verdict?: string; changedFeatureKeys?: string[] };
    const reanalyze = details.verdict === "reanalyze";
    io.stderr(t({ zh: `分析期间账本前进了（当前版本 #${details.current?.specVersionId ?? "?"}）。服务端的判定：${reanalyze ? "需要重新分析" : "提案可以复用"}，变化了 ${details.changedFeatureKeys?.length ?? 0} 个功能。请重新运行 publish${reanalyze ? "（带 --full）" : ""}。`, en: `The ledger moved on while you were analysing (now version #${details.current?.specVersionId ?? "?"}). Verdict: ${reanalyze ? "reanalyse" : "reusable"}; ${details.changedFeatureKeys?.length ?? 0} feature(s) changed. Run publish again${reanalyze ? " with --full" : ""}.` }));
    return 4;
  }
  if (status === 422 && body.error === "artifact_contains_source") {
    const hits = (body.hits ?? []) as Array<{ rule: string; path: string; line: number }>;
    io.stderr(t({ zh: `提案里有看起来像源码的内容，服务端没有收（${hits.length} 处：${hits.slice(0, 10).map((hit) => `${hit.path}:${hit.line}（${hit.rule}）`).join("，")}）。请升级客户端后重试。`, en: `The server refused the proposal because it contains text that looks like source code (${hits.length}: ${hits.slice(0, 10).map((hit) => `${hit.path}:${hit.line} (${hit.rule})`).join(", ")}). Upgrade the client and try again.` }));
    return 5;
  }
  if (status === 429) {
    io.stderr(t({ zh: "上传太频繁：每个 key 每小时最多 10 次，请稍后再试。", en: "Too many uploads: at most 10 per key per hour. Try again later." }));
    return 5;
  }
  io.stderr(t({ zh: `发布被拒绝：${String(body.error ?? status)}${typeof body.message === "string" ? `（${body.message}）` : ""}`, en: `Publishing was refused: ${String(body.error ?? status)}${typeof body.message === "string" ? ` (${body.message})` : ""}` }));
  return 1;
}

// ───────────────────────────── 真实的终端输入输出 ─────────────────────────────

/** 不回显的读法：readline 负责回显，把它的输出接到一个吞掉写入的流上，终端就不显示输入的内容。 */
function secretReader(): (prompt: string, options?: { secret?: boolean }) => Promise<string> {
  return (prompt, options) =>
    new Promise((resolve, reject) => {
      process.stdout.write(prompt);
      const silent = options?.secret === true && process.stdin.isTTY;
      const muted = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
      const lines = createInterface({ input: process.stdin, output: silent ? muted : process.stdout, terminal: silent });
      lines.once("SIGINT", () => {
        lines.close();
        reject(new Error("interrupted"));
      });
      lines.once("line", (line) => {
        lines.close();
        if (silent) process.stdout.write("\n");
        resolve(line);
      });
    });
}

/** 给真正的命令行用：标准输出、标准错误、不回显的输入、从标准输入读 --value-stdin 的值。 */
export function consoleIo(environment: Record<string, string | undefined> = process.env): CliIo {
  return {
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
    environment,
    ask: secretReader(),
    readStdin: async () => readFileSync(0, "utf8"),
  };
}
