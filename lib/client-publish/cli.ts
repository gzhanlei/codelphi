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
import { AiOutputTruncatedError, createStandaloneClientFromEnv } from "../llm-client";
import { runGit } from "../snapshot/git";
import { resolveGitSnapshot } from "../snapshot/git-backend";
import { basename } from "node:path";
import type { RepositoryIdentity } from "../client-proposal/contract";
import { CREDENTIAL_KEYS, credentialsPath, DEFAULT_SERVER_URL, describeConfig, readCredentials, resolveConfig, writeCredentials } from "./credentials";
import { ClientPublishError, produceProposal, type ProduceProgress } from "./produce";
import { loadPreparedPublish, PublishRunError, type PreparedPublish } from "./run-store";
import type { PrivacyRule } from "../privacy-scan";
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
      // 接入向导。两句话各放在要 key 之前，说的是用户刚刚确认的那个地址。模型服务地址没有默认值：
      // 用哪家服务商是用户的决定，不替他猜；没配过就必须要他填。
      const serverUrl = stored.CODELPHI_SERVER_URL || io.environment.CODELPHI_SERVER_URL || DEFAULT_SERVER_URL;
      const knownModelBase = stored.AI_BASE_URL || io.environment.AI_BASE_URL;
      updates = {};
      const ask = async (prompt: string, options?: { secret?: boolean }): Promise<string> => (io.ask ? io.ask(prompt, options) : "");
      const keep = (key: string, fallback: string) => stored[key] ?? io.environment[key] ?? fallback;
      const answer = await ask(t({ zh: `服务地址 [${serverUrl}]: `, en: `Server address [${serverUrl}]: ` }));
      if (answer.trim()) updates.CODELPHI_SERVER_URL = answer.trim();
      io.stdout(t({ zh: `分析提案将上传到 ${updates.CODELPHI_SERVER_URL ?? serverUrl}，内容不含源码文件和补丁。`, en: `Analysis proposals are uploaded to ${updates.CODELPHI_SERVER_URL ?? serverUrl}; they contain no source files and patches.` }));
      const uploadKey = await ask(t({ zh: "上传 key: ", en: "Upload key: " }), { secret: true });
      if (uploadKey.trim()) updates.CODELPHI_SNAPSHOT_KEY = uploadKey.trim();
      else if (!keep("CODELPHI_SNAPSHOT_KEY", "")) {
        io.stderr(t({ zh: "没有上传 key 就无法发布。请先在 CoDelphi 的设置页创建一把 snapshot_write 权限的 key。", en: "Publishing needs an upload key. Create a snapshot_write key in your CoDelphi settings first." }));
        return 2;
      }
      const modelAnswer = await ask(knownModelBase ? t({ zh: `模型服务地址 [${knownModelBase}]: `, en: `Model service address [${knownModelBase}]: ` }) : t({ zh: "模型服务地址: ", en: "Model service address: " }));
      const modelBase = modelAnswer.trim() || knownModelBase;
      if (!modelBase) {
        io.stderr(t({ zh: "需要模型服务地址：填你的模型服务商给出的 OpenAI 兼容地址（它文档里的 Base URL）。不填就不知道请求该发到哪里，所以这里没有默认值。", en: "The model service address is needed: the OpenAI-compatible address your model provider documents (its Base URL). Nothing is sent anywhere by default." }));
        return 2;
      }
      if (modelAnswer.trim()) updates.AI_BASE_URL = modelAnswer.trim();
      io.stdout(t({ zh: `模型请求将发送到 ${modelBase}，不经过 CoDelphi 服务端。`, en: `Model requests go to ${modelBase}; they do not pass through the CoDelphi server.` }));
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

const PUBLISH_USAGE: Text = {
  zh: "用法：publish <本地仓库路径> [--slug <产品别名>] [--full] [--dry-run] [--provider <github|gitlab|gitee|gitea>] [--workdir <工作目录> [--prepare | --finalize]]",
  en: "Usage: publish <local repository> [--slug <product>] [--full] [--dry-run] [--provider <github|gitlab|gitee|gitea>] [--workdir <work directory> [--prepare | --finalize]]",
};

/** 工作目录里没有可用的准备结果时，说清楚缺什么、下一步做什么。三句话都带 --prepare：那是一定要走的下一步。 */
function runErrorText(error: PublishRunError, workdir: string, currentSha: string): Text {
  if (error.code === "publish_target_mismatch") {
    return {
      zh: `${workdir} 里准备的是另一个提交的分析结果，本地仓库现在在 ${currentSha.slice(0, 12)}。要发准备好的那一份，先切回那个提交再运行 --finalize；要按新的提交分析，重新运行 --prepare，做过的部分会沿用。`,
      en: `${workdir} was prepared for another commit and the repository is now at ${currentSha.slice(0, 12)}. Check that commit out again to run --finalize, or run --prepare for the new commit; finished work is reused.`,
    };
  }
  if (error.code === "publish_corrupt") {
    return {
      zh: `${workdir} 里准备好的提案和它自己的哈希对不上，文件可能被截断或改过。重新运行 --prepare，做过的部分会沿用。`,
      en: `The proposal prepared in ${workdir} no longer matches its own hash; the files may be truncated or edited. Run --prepare again; finished work is reused.`,
    };
  }
  return {
    zh: `${workdir} 里没有这个产品、这个仓库准备好、可以上传的提案。先运行 publish --prepare。`,
    en: `${workdir} holds no finished proposal for this product and repository to upload. Run publish --prepare first.`,
  };
}

/** 被隐私扫描剔除的条目：哪一项、因为哪条规则。 */
function printPruned(pruned: ReadonlyArray<{ path: string; rules: PrivacyRule[] }>, io: CliIo, t: (text: Text) => string): void {
  if (pruned.length === 0) return;
  io.stderr(t({ zh: `隐私扫描剔除了 ${pruned.length} 处（看起来像源码的内容不上传）：`, en: `The privacy scan removed ${pruned.length} item(s) that looked like source code; they were not uploaded:` }));
  for (const item of pruned) io.stderr(`  ${item.path}（${item.rules.join("、")}）`);
}

function durationText(durationMs: number, language: Language): string {
  return `${(durationMs / 1000).toFixed(1)} ${language === "en" ? "s" : "秒"}`;
}

function progressPosition(event: ProduceProgress): string {
  return "current" in event && event.current !== undefined && "total" in event && event.total !== undefined ? ` ${event.current}/${event.total}` : "";
}

function progressText(event: ProduceProgress, language: Language): string {
  const stage = stageText(event.stage);
  const position = progressPosition(event);
  const duration = "durationMs" in event && event.durationMs !== undefined ? durationText(event.durationMs, language) : "";
  const retries = "retries" in event ? event.retries ?? 0 : 0;
  if (event.status === "start") {
    if (event.stage === "enumerate" && event.message) return say({ zh: `… 行为面枚举（${event.message} 个行为变更文件）`, en: `... enumerating behaviour (${event.message} changed files)` }, language);
    return say({ zh: `… ${stage.zh}${position}`, en: `... ${stage.en}${position}` }, language);
  }
  if (event.status === "retry") {
    return say({ zh: `重试：${stage.zh}${position}的第 1 次请求失败（${event.message ?? "未知错误"}），正在重试；每个分区最多请求 2 次。`, en: `Retrying: ${stage.en}${position}, attempt 1 failed (${event.message ?? "unknown error"}); at most 2 attempts are made per partition.` }, language);
  }
  if (event.status === "fallback") {
    return say({ zh: `提示：${stage.zh}失败，改用功能索引${duration ? `（${duration}）` : ""}。`, en: `Notice: ${stage.en} failed; using the feature index instead${duration ? ` (${duration})` : ""}.` }, language);
  }
  if (event.stage === "plan") return say({ zh: `完成：规划出 ${event.total ?? 0} 个分析分区。`, en: `Completed: planned ${event.total ?? 0} analysis partitions.` }, language);
  if (event.stage === "partition" && event.message === "reused") return say({ zh: `完成：${stage.zh}${position}（沿用工作目录结果）。`, en: `Completed: ${stage.en}${position} (reused from the work directory).` }, language);
  const details = [
    ...(duration ? [duration] : []),
    ...(event.stage === "partition" ? [say({ zh: `重试 ${retries} 次`, en: `${retries} retries` }, language)] : []),
    ...(event.message && event.stage !== "partition" ? [event.message] : []),
  ];
  return say({ zh: `完成：${stage.zh}${position}${details.length ? `（${details.join("，")}）` : ""}。`, en: `Completed: ${stage.en}${position}${details.length ? ` (${details.join(", ")})` : ""}.` }, language);
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === "TimeoutError" || typeof candidate.message === "string" && /aborted due to timeout|timed out|timeout/i.test(candidate.message);
}

function truncationFailureText(error: unknown, progress: ProduceProgress | undefined, maxTokens: number, workdir: string | undefined, language: Language): string | null {
  if (!AiOutputTruncatedError.isInstance(error) || !progress || !["partition", "presentation", "enumerate", "flows"].includes(progress.stage)) return null;
  const stage = stageText(progress.stage);
  const position = progressPosition(progress);
  const suggested = Math.max(65_536, maxTokens * 2);
  const resumption = workdir
    ? say({ zh: `重新运行同一命令会沿用已完成的分区和其他结果。`, en: `Rerunning the same command will reuse completed partitions and other finished work.` }, language)
    : say({ zh: `可用 --workdir 保存中间结果，便于中断后续跑。`, en: `Use --workdir to save intermediate results for a later resume.` }, language);
  return say({
    zh: `发布失败：${stage.zh}${position}的模型输出达到 ${maxTokens} token 上限，JSON 未生成完整。可将 AI_MAX_TOKENS 调大（例如 ${suggested}）后重试；这与 AI_TIMEOUT_MS 请求超时无关。${resumption}原始错误：${errorMessage(error)}`,
    en: `Publish failed: the model output for ${stage.en}${position} reached the ${maxTokens}-token limit, leaving incomplete JSON. Increase AI_MAX_TOKENS (for example to ${suggested}) and retry; this is unrelated to the AI_TIMEOUT_MS request timeout. ${resumption} Original error: ${errorMessage(error)}`,
  }, language);
}

function timeoutFailureText(error: unknown, progress: ProduceProgress | undefined, timeoutMs: number, workdir: string | undefined, language: Language): string | null {
  if (!isTimeout(error) || !progress || !["partition", "presentation", "enumerate", "flows"].includes(progress.stage)) return null;
  const stage = stageText(progress.stage);
  const position = progressPosition(progress);
  const seconds = Number((timeoutMs / 1000).toFixed(1));
  const suggested = Math.max(600_000, timeoutMs * 2);
  const retried = progress.status === "retry";
  const resumption = workdir
    ? say({ zh: `重新运行同一命令会沿用已完成的分区和其他结果。`, en: `Rerunning the same command will reuse completed partitions and other finished work.` }, language)
    : say({ zh: `可用 --workdir 保存中间结果，便于中断后续跑。`, en: `Use --workdir to save intermediate results for a later resume.` }, language);
  return say({
    zh: `发布失败：${stage.zh}${position}的模型请求${retried ? "重试后仍" : ""}超过 ${seconds} 秒，被客户端主动中止。可将 AI_TIMEOUT_MS 调大（例如 ${suggested}）后重试；${resumption}原始错误：${errorMessage(error)}`,
    en: `Publish failed: the model request for ${stage.en}${position} ${retried ? "still " : ""}exceeded ${seconds}s and was aborted by the client. Increase AI_TIMEOUT_MS (for example to ${suggested}) and retry; ${resumption} Original error: ${errorMessage(error)}`,
  }, language);
}

export async function publishMain(argv: string[], io: CliIo): Promise<number> {
  const language = languageOf(argv);
  const t = (text: Text) => say(text, language);
  let lastProgress: ProduceProgress | undefined;
  let modelTimeoutMs = 180_000;
  let modelMaxTokens = 16_000;
  let runWorkdir: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv.filter((argument, index) => argument !== "--language" && argv[index - 1] !== "--language"),
      allowPositionals: true,
      options: {
        slug: { type: "string" },
        full: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        provider: { type: "string" },
        workdir: { type: "string" },
        prepare: { type: "boolean", default: false },
        finalize: { type: "boolean", default: false },
      },
    }) as { values: { slug?: string; full: boolean; "dry-run": boolean; provider?: string; workdir?: string; prepare: boolean; finalize: boolean }; positionals: string[] };
    // 分步续跑：--prepare 只分析并落盘，--finalize 只上传，都靠工作目录接续。一次跑完的 publish 也认 --workdir，中断后重跑只补没做完的。
    const stage = values.prepare && values.finalize ? null : values.prepare ? "prepare" : values.finalize ? "finalize" : "publish";
    if (positionals.length !== 1 || stage === null || (stage !== "publish" && !values.workdir)) {
      io.stderr(t(PUBLISH_USAGE));
      if (stage !== null && stage !== "publish" && !values.workdir) io.stderr(t({ zh: `--${stage} 要配合 --workdir 指定一个工作目录。`, en: `--${stage} needs --workdir to name a work directory.` }));
      return 2;
    }
    const config = await loadConfig(io, io.credentialsFile ?? credentialsPath({ env: io.environment }));
    modelTimeoutMs = Number(config.AI_TIMEOUT_MS) || 180_000;
    const configuredMaxTokens = Number(config.AI_MAX_TOKENS);
    modelMaxTokens = Number.isInteger(configuredMaxTokens) && configuredMaxTokens > 0 ? configuredMaxTokens : 16_000;
    runWorkdir = values.workdir;
    if (!config.CODELPHI_SNAPSHOT_KEY) {
      io.stderr(t({ zh: "缺少上传 key：请先运行 config，填写 CODELPHI_SNAPSHOT_KEY。", en: "Upload key is missing: run config and fill in CODELPHI_SNAPSHOT_KEY." }));
      return 2;
    }
    // --finalize 不调模型，所以不要模型的凭证：分析在一台机器上做，上传可以在另一台上。
    if (stage !== "finalize" && (!config.AI_API_KEY || !config.AI_MODEL)) {
      io.stderr(t({ zh: "缺少模型配置：请先运行 config，填写 AI_API_KEY 与 AI_MODEL。", en: "Model configuration is missing: run config and fill in AI_API_KEY and AI_MODEL." }));
      return 2;
    }
    // 发模型请求的那段代码在没有地址时会退到本机网关 http://127.0.0.1:4000。不替用户做这个决定：要他先填。
    if (stage !== "finalize" && !config.AI_BASE_URL) {
      io.stderr(t({ zh: "缺少模型服务地址：请先运行 config，填写 AI_BASE_URL（你的模型服务商给出的 OpenAI 兼容地址）。没有它就不知道该把请求和 key 发到哪里。", en: "The model service address is missing: run config and fill in AI_BASE_URL (the OpenAI-compatible address your model provider documents). Without it there is no way to know where requests and the key should go." }));
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
    if (stage === "finalize") {
      // 只上传。工作目录里准备的是哪个提交，以它为准：本地仓库已经前进的话，不在不知不觉中把旧的发出去。
      const snapshot = await resolveGitSnapshot(positionals[0]);
      const workdir = values.workdir as string;
      let prepared: PreparedPublish;
      try {
        prepared = await loadPreparedPublish(workdir, { repositoryRoot: snapshot.repoRoot, productSlug: selected.product.slug, targetSha: snapshot.revision });
      } catch (error) {
        if (!(error instanceof PublishRunError)) throw error;
        io.stderr(t(runErrorText(error, workdir, snapshot.revision)));
        return 2;
      }
      const features = prepared.proposal.proposal.features;
      const scenarios = features.reduce((total, feature) => total + feature.scenarios.length, 0);
      io.stdout(t({ zh: `使用 ${workdir} 里准备好的提案：提交 ${prepared.proposal.revision.sha.slice(0, 12)}，${features.length} 个功能、${scenarios} 条场景。`, en: `Using the proposal prepared in ${workdir}: commit ${prepared.proposal.revision.sha.slice(0, 12)}, ${features.length} features, ${scenarios} scenarios.` }));
      printPruned(prepared.summary.pruned, io, t);
      const upload = await uploadProposal(server, selected.product.slug, JSON.stringify(prepared.proposal), { fetchImpl: io.fetchImpl });
      return reportUpload(upload.status, upload.body, prepared.proposal.revision.sha, server, selected.product.slug, io, t);
    }
    const client = (io.createClient ?? createStandaloneClientFromEnv)(config);
    io.stderr(t({ zh: `分析模型：${client.displayName ?? config.AI_MODEL}；单次模型请求超时上限：${Number((modelTimeoutMs / 1000).toFixed(1))} 秒；输出 token 上限：${modelMaxTokens}。`, en: `Analysis model: ${client.displayName ?? config.AI_MODEL}; timeout per model request: ${Number((modelTimeoutMs / 1000).toFixed(1))}s; output token limit: ${modelMaxTokens}.` }));
    const result = await produceProposal({
      repositoryRoot: positionals[0],
      product: selected.product,
      full: values.full,
      outputLanguage: language,
      client,
      modelName: client.displayName ?? config.AI_MODEL,
      ...(values.provider ? { provider: values.provider as RepositoryIdentity["provider"] } : {}),
      ...(values.workdir ? { workdir: values.workdir } : {}),
      onProgress: (event) => {
        lastProgress = event;
        io.stderr(progressText(event, language));
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
    const reused = result.reused;
    if (reused.partitions + reused.flows > 0 || reused.enumeration || reused.presentation) {
      const parts = [
        ...(reused.partitions > 0 ? [t({ zh: `分区 ${reused.partitions}`, en: `${reused.partitions} partition(s)` })] : []),
        ...(reused.enumeration ? [t({ zh: "行为面枚举", en: "behaviour enumeration" })] : []),
        ...(reused.presentation ? [t({ zh: "理解层", en: "the presentation" })] : []),
        ...(reused.flows > 0 ? [t({ zh: `流程图 ${reused.flows}`, en: `${reused.flows} flow graph(s)` })] : []),
      ];
      io.stderr(t({ zh: `续跑：沿用了工作目录里已经完成的结果（${parts.join("、")}），没有为它们再调模型。`, en: `Resuming: finished work was taken from the work directory (${parts.join(", ")}); the model was not called again for it.` }));
    }
    const features = proposal.proposal.features;
    const scenarios = features.reduce((total, feature) => total + feature.scenarios.length, 0);
    io.stdout(t({ zh: `全量分析：${features.length} 个功能、${scenarios} 条场景；变更窗口 ${proposal.window?.files.length ?? 0} 个文件（其中行为变更 ${proposal.window?.files.filter((file) => file.behavioral).length ?? 0} 个）；流程图 ${result.flows.generated} 张。`, en: `Full analysis: ${features.length} features, ${scenarios} scenarios; change window ${proposal.window?.files.length ?? 0} files (${proposal.window?.files.filter((file) => file.behavioral).length ?? 0} with behavioural changes); ${result.flows.generated} flow graphs.` }));
    for (const feature of features) io.stdout(`  ${feature.name}: ${feature.scenarios.map((scenario) => scenario.reference).join(" ")}`);
    printPruned(result.pruned, io, t);
    if (stage === "prepare") {
      io.stdout(t({ zh: `已保存到 ${values.workdir}，没有上传。确认无误后上传：publish <本地仓库路径> --slug ${selected.product.slug} --workdir ${values.workdir} --finalize`, en: `Saved to ${values.workdir}; nothing was uploaded. To upload once you have checked it: publish <local repository> --slug ${selected.product.slug} --workdir ${values.workdir} --finalize` }));
      return 0;
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
    const failureText = truncationFailureText(error, lastProgress, modelMaxTokens, runWorkdir, language)
      ?? timeoutFailureText(error, lastProgress, modelTimeoutMs, runWorkdir, language);
    io.stderr(failureText ?? t({ zh: `发布失败：${errorMessage(error)}`, en: `Publish failed: ${errorMessage(error)}` }));
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
    case "partition": return { zh: "提取分区", en: "extracting partition" };
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
    // 首次发布接住了雷达快照导入的草稿时，服务端在回执里写明接了多少行。租户原先在工作台里看到的就是这些行，要说清楚它们去哪了。
    const absorbed = body.draftAbsorbed as { features?: unknown; scenarios?: unknown } | undefined;
    if (typeof absorbed?.features === "number" && typeof absorbed.scenarios === "number") {
      io.stdout(t({ zh: `导入的草稿并进了这次发布：${absorbed.features} 个功能、${absorbed.scenarios} 条场景。同名同引用的沿用原来的条目并换成这次的内容，这次没有分析到的停用，不再显示在工作台里。`, en: `The imported draft was taken over by this publish: ${absorbed.features} features and ${absorbed.scenarios} scenarios. Entries the analysis named again kept their place and now carry the new content; the ones it did not are retired and no longer shown in the workbench.` }));
    }
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
