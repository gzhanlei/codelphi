import { randomUUID } from "node:crypto";
import { appendFile, link, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runSnapshot, type SnapshotRunOptions, type SnapshotRunResult } from "../lib/snapshot/run";
import { completeSnapshotWorkspace, finalizeSnapshotWorkspace, prepareSnapshotWorkspace, readSnapshotWorkOrder } from "../lib/snapshot/workspace";
import { resolveCompletionBackend } from "../lib/snapshot/host-ai";
import { standaloneGatewayHost, type CompletionUsageHandler } from "../lib/llm-client";
import type { SnapshotProgressEvent } from "../lib/snapshot/types";

class SnapshotCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SnapshotCliError";
  }
}

interface CliValues {
  ref?: string;
  scope?: string[];
  language?: string;
  "env-file"?: string;
  standalone: boolean;
  output?: string;
  force: boolean;
  help: boolean;
}

interface CliDependencies {
  run?: (options: SnapshotRunOptions) => Promise<SnapshotRunResult>;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  environment?: Record<string, string | undefined>;
}

function languageFromArgv(argv: string[]): "zh-CN" | "en" {
  const inline = argv.find((argument) => argument.startsWith("--language="));
  if (inline) return inline.slice("--language=".length) === "en" ? "en" : "zh-CN";
  const index = argv.indexOf("--language");
  return index >= 0 && argv[index + 1] === "en" ? "en" : "zh-CN";
}

function usage(language: "zh-CN" | "en") {
  return language === "en"
    ? `Usage: npm run snapshot -- <local-path|github-url> [options]\n\nOptions:\n  --ref <revision>       Commit, branch or tag to analyze\n  --scope <path>         Limit analysis to a repository path (repeatable)\n  --language <zh-CN|en>  Language for CLI messages and the HTML report\n  --env-file <path>      Explicit standalone AI configuration file\n  --standalone          Explicitly use standalone AI configuration\n  --output <file>       HTML output path\n  --force               Overwrite an existing report\n  --help                Show this help`
    : `用法：npm run snapshot -- <本地路径|GitHub公开仓库URL> [选项]\n\n选项：\n  --ref <revision>       要分析的 commit、分支或标签\n  --scope <path>         限定仓库内分析路径（可重复）\n  --language <zh-CN|en>  CLI 消息与 HTML 报告语言\n  --env-file <path>      显式 standalone AI 配置文件\n  --standalone          显式使用 standalone AI 配置\n  --output <file>       HTML 输出路径\n  --force               覆盖已有报告\n  --help                显示此帮助`;
}

function parseEnvironmentFile(content: string) {
  const result: Record<string, string> = {};
  for (const row of content.split(/\r?\n/)) {
    const line = row.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const raw = rawValue.trim();
    let value: string;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw) as string; } catch { throw new SnapshotCliError("invalid_env_file", `Invalid quoted value for ${key}`); }
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      if (end < 0) throw new SnapshotCliError("invalid_env_file", `Invalid quoted value for ${key}`);
      value = raw.slice(1, end);
    } else {
      value = raw.split(/\s+#/, 1)[0].trim();
    }
    result[key] = value;
  }
  return result;
}

function scopeRoots(values: string[] | undefined) {
  return (values ?? []).map((value) => {
    const path = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    if (!path || path === ".git" || path.startsWith("/") || path.split("/").some((segment) => segment === "..")) {
      throw new SnapshotCliError("invalid_scope", `Invalid repository scope: ${value}`);
    }
    return { path, role: "shared" as const };
  });
}

async function outputExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeReportAtomically(path: string, html: string, force: boolean) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, html, { encoding: "utf8", flag: "wx" });
    if (force) await rename(temporary, path);
    else await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SnapshotCliError("output_exists", `Output already exists: ${path}`);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function defaultOutputPath(result: SnapshotRunResult) {
  const safeName = result.report.snapshot.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
  return resolve(process.cwd(), `codelphi-${safeName}-${result.report.snapshot.revision.slice(0, 8)}.html`);
}

function progressReporter(language: "zh-CN" | "en", stderr: (message: string) => void) {
  const seconds = (ms?: number) => ((ms ?? 0) / 1000).toFixed(1);
  return (event: SnapshotProgressEvent) => {
    const position = event.current && event.total ? `${event.current}/${event.total}` : "";
    if (event.stage === "plan" && event.status === "complete") {
      stderr(language === "en" ? `Analysis partitions planned: ${event.total}` : `分析分区规划完成：共 ${event.total} 个分区`);
      return;
    }
    if (event.stage === "partition" && event.status === "start") {
      stderr(language === "en" ? `Partition ${position}: extraction started` : `分区 ${position}：开始提取`);
      return;
    }
    if (event.stage === "partition" && event.status === "retry") {
      stderr(language === "en" ? `Partition ${position}: model call failed; retrying. ${event.message ?? ""}` : `分区 ${position}：模型调用失败，正在重试。${event.message ?? ""}`);
      return;
    }
    if (event.stage === "partition" && event.status === "complete") {
      const retry = event.retries ? (language === "en" ? `, ${event.retries} retry` : `，重试 ${event.retries} 次`) : "";
      stderr(language === "en" ? `Partition ${position}: completed in ${seconds(event.durationMs)}s${retry}` : `分区 ${position}：完成，耗时 ${seconds(event.durationMs)} 秒${retry}`);
      return;
    }
    if (event.stage === "presentation" && event.status === "start") {
      stderr(language === "en" ? "Building the project map, journeys, and concepts..." : "正在生成项目地图、用户旅程与概念关系……");
      return;
    }
    if (event.stage === "presentation" && event.status === "complete") {
      stderr(language === "en" ? `Project map completed in ${seconds(event.durationMs)}s` : `项目地图生成完成，耗时 ${seconds(event.durationMs)} 秒`);
      return;
    }
    if (event.stage === "presentation" && event.status === "fallback") {
      stderr(language === "en" ? `Presentation validation failed; using the complete feature index in ${seconds(event.durationMs)}s` : `展示结果未通过校验，使用完整功能索引（耗时 ${seconds(event.durationMs)} 秒）`);
    }
  };
}

function errorText(error: unknown, language: "zh-CN" | "en") {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, { zh: string; en: string }> = {
    missing_ai_config: { zh: "缺少 standalone AI 配置；请设置 AI_API_KEY 与 AI_MODEL，或使用 --env-file。", en: "Standalone AI configuration is missing. Set AI_API_KEY and AI_MODEL, or use --env-file." },
    output_exists: { zh: "输出文件已存在；如需覆盖，请显式使用 --force。", en: "The output file already exists. Use --force to overwrite it explicitly." },
    no_valid_spec: { zh: "未能提取带有效证据的产品功能，因此不生成成功报告。", en: "No evidence-backed product features were extracted, so no success report was generated." },
    host_ai_unavailable: { zh: "当前宿主未开放可调用的当前模型接口；可显式选择 --standalone。", en: "The current host does not expose its active model for programmatic calls. You may explicitly select --standalone." },
    host_cli_timeout: { zh: "宿主模型调用超时，请查看上方分区进度定位停顿阶段。", en: "The host model call timed out. Check the partition progress above to locate the stalled stage." },
  };
  const localized = code ? messages[code] : undefined;
  if (localized) return language === "en" ? localized.en : localized.zh;
  const detail = error instanceof Error ? error.message : String(error);
  return language === "en" ? `Snapshot failed: ${detail}` : `快照分析失败：${detail}`;
}

async function workspaceMain(argv: string[], dependencies: CliDependencies) {
  const [command, ...args] = argv;
  const language = languageFromArgv(args);
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        ref: { type: "string" },
        scope: { type: "string", multiple: true },
        language: { type: "string" },
        workdir: { type: "string" },
        partition: { type: "string" },
        concurrency: { type: "string" },
        "env-file": { type: "string" },
        standalone: { type: "boolean", default: false },
      },
    }) as { values: CliValues & { workdir?: string; partition?: string; concurrency?: string }; positionals: string[] };
    if (!values.workdir) {
      stderr(language === "en" ? "Missing --workdir" : "缺少 --workdir");
      return 2;
    }
    const directory = resolve(values.workdir);
    if (command === "prepare" && positionals.length === 1) {
      const { manifest } = await prepareSnapshotWorkspace({ directory, target: positionals[0], ref: values.ref, scopeRoots: scopeRoots(values.scope), outputLanguage: language });
      stdout(language === "en" ? `Workspace prepared: ${directory} (${manifest.workOrderIds.length} work orders)` : `工作目录已准备：${directory}（${manifest.workOrderIds.length} 个工作单）`);
      return 0;
    }
    if (command === "show" && positionals.length === 0 && values.partition) {
      const workOrder = await readSnapshotWorkOrder(directory, values.partition);
      stdout(JSON.stringify(workOrder, null, 2));
      return 0;
    }
    if (command === "complete" && positionals.length === 0) {
      const environment: Record<string, string | undefined> = { ...(dependencies.environment ?? process.env) };
      if (values["env-file"]) {
        const parsed = parseEnvironmentFile(await readFile(resolve(values["env-file"]), "utf8"));
        for (const key of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL"] as const) {
          if (environment[key] === undefined && parsed[key] !== undefined) environment[key] = parsed[key];
        }
      }
      const usageLog = environment.CODELPHI_USAGE_LOG?.trim();
      let pendingUsageWrites: Promise<void> = Promise.resolve();
      const onUsage: CompletionUsageHandler | undefined = usageLog ? (usage, metadata) => {
        const record = { timestamp: new Date().toISOString(), model: environment.AI_MODEL, requestId: metadata.requestId, durationMs: metadata.durationMs, usage };
        pendingUsageWrites = pendingUsageWrites.then(() => appendFile(resolve(usageLog), `${JSON.stringify(record)}\n`, "utf8"));
        return pendingUsageWrites;
      } : undefined;
      const backend = resolveCompletionBackend({ environment, standalone: values.standalone === true || Boolean(values["env-file"]), host: environment.CODELPHI_SKILL_HOST?.trim(), ...(onUsage ? { onUsage } : {}) });
      if (backend.kind === "unavailable") {
        stderr(language === "en"
          ? `No completion backend available.\n  Tried:\n    - ${backend.reasons.join("\n    - ")}\n  Options: (1) pass --env-file or set AI_API_KEY/AI_MODEL for standalone; (2) have the host inject CODELPHI_HOST_AI_BRIDGE_URL/TOKEN or CODELPHI_HOST_AI_COMMAND (+CODELPHI_HOST_AI_ARGS_JSON); (3) run the host-native agent flow (SKILL.md step 3).`
          : `没有可用的完成通道。\n  已尝试：\n    - ${backend.reasons.join("\n    - ")}\n  可选：(1) 用 --env-file 或设置 AI_API_KEY/AI_MODEL 走 standalone；(2) 由宿主注入 CODELPHI_HOST_AI_BRIDGE_URL/TOKEN 或 CODELPHI_HOST_AI_COMMAND（+CODELPHI_HOST_AI_ARGS_JSON）；(3) 按 SKILL.md 第 3 步由宿主代理逐个完成工作单。`);
        return 1;
      }
      stdout(language === "en"
        ? `Completion backend: ${backend.kind === "standalone" ? `standalone (${backend.client.displayName ?? "configured model"})` : `host bridge (${backend.client.displayName ?? "host current model"})`}`
        : `完成通道：${backend.kind === "standalone" ? `standalone（${backend.client.displayName ?? "已配置模型"}）` : `宿主桥（${backend.client.displayName ?? "宿主当前模型"}）`}`);
      const outcome = await completeSnapshotWorkspace({
        directory,
        client: backend.client,
        concurrency: Number(values.concurrency) || 4,
        onProgress: (message) => stderr(message),
      });
      await pendingUsageWrites;
      stdout(language === "en"
        ? `Complete finished: ${outcome.completed.length} completed, ${outcome.failed.length} failed, ${outcome.skippedExisting} reused; presentation: ${outcome.presentation}`
        : `完成结束：${outcome.completed.length} 个成功，${outcome.failed.length} 个失败，复用已有 ${outcome.skippedExisting} 个；展示结果：${outcome.presentation}`);
      return outcome.failed.length > 0 ? 1 : 0;
    }
    if (command === "finalize" && positionals.length === 0) {
      const result = await finalizeSnapshotWorkspace(directory);
      stdout(language === "en" ? `Radar report written to ${result.outputPath}` : `Radar 报告已生成：${result.outputPath}`);
      stdout(language === "en" ? `Import artifact written to ${result.snapshotExportPath}` : `导入产物已生成：${result.snapshotExportPath}`);
      // BYO 自动上传（设计 §9）：CODELPHI_IMPORT_URL + CODELPHI_SNAPSHOT_KEY 同时在位时，
      // finalize 即上传 snapshot.json（失败只告警，不阻断 finalize 产物）。
      const uploadUrl = process.env.CODELPHI_IMPORT_URL;
      const uploadKey = process.env.CODELPHI_SNAPSHOT_KEY;
      if (uploadUrl && uploadKey) {
        try {
          const body = await readFile(result.snapshotExportPath, "utf8");
          const response = await fetch(`${uploadUrl.replace(/\/$/, "")}/api/products/import-snapshot`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${uploadKey}` },
            body,
          });
          const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
          if (!response.ok) {
            stderr(language === "en"
              ? `Upload failed: HTTP ${response.status} ${JSON.stringify(payload)} (artifacts remain local; set CODELPHI_IMPORT_URL/CODELPHI_SNAPSHOT_KEY or unset to disable)`
              : `上传失败：HTTP ${response.status} ${JSON.stringify(payload)}（产物保留在本地；可修正环境变量重试，或取消这两个变量以关闭自动上传）`);
          } else {
            stdout(language === "en"
              ? `Uploaded to CoDelphi: product #${payload.productId} (${payload.slug ?? "?"}), imported=${payload.imported}, scenarios=${payload.scenariosImported}`
              : `已上传到 CoDelphi：产品 #${payload.productId}（${payload.slug ?? "?"}），imported=${payload.imported}，场景数=${payload.scenariosImported}`);
          }
        } catch (error) {
          stderr(language === "en" ? `Upload failed: ${error instanceof Error ? error.message : String(error)}` : `上传失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return 0;
    }
    if (command === "upload" && positionals.length === 0) {
      // 独立上传：已 finalize 过的工作目录，读 snapshot.json 直接重传（幂等键=revision+treeSha）。
      const uploadPath = join(directory, "snapshot.json");
      const uploadUrl = process.env.CODELPHI_IMPORT_URL;
      const uploadKey = process.env.CODELPHI_SNAPSHOT_KEY;
      if (!uploadUrl || !uploadKey) {
        stderr(language === "en"
          ? "upload requires CODELPHI_IMPORT_URL and CODELPHI_SNAPSHOT_KEY in the environment"
          : "upload 需要环境变量 CODELPHI_IMPORT_URL 与 CODELPHI_SNAPSHOT_KEY");
        return 2;
      }
      const body = await readFile(uploadPath, "utf8");
      const response = await fetch(`${uploadUrl.replace(/\/$/, "")}/api/products/import-snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${uploadKey}` },
        body,
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        stderr(`Upload failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
        return 1;
      }
      stdout(`Uploaded: product #${payload.productId} (${payload.slug ?? "?"}), imported=${payload.imported}, scenarios=${payload.scenariosImported}`);
      return 0;
    }
    stderr(language === "en" ? "Usage: prepare <target> --workdir <dir> | show --workdir <dir> --partition <id> | complete --workdir <dir> | finalize --workdir <dir> | upload --workdir <dir>" : "用法：prepare <目标> --workdir <目录> | show --workdir <目录> --partition <id> | complete --workdir <目录> | finalize --workdir <目录> | upload --workdir <目录>");
    return 2;
  } catch (error) {
    stderr(errorText(error, language));
    return 1;
  }
}

export async function main(argv = process.argv.slice(2), dependencies: CliDependencies = {}) {
  if (argv[0] === "prepare" || argv[0] === "finalize" || argv[0] === "show" || argv[0] === "complete" || argv[0] === "upload") return workspaceMain(argv, dependencies);
  const language = languageFromArgv(argv);
  const stdout = dependencies.stdout ?? ((message: string) => console.log(message));
  const stderr = dependencies.stderr ?? ((message: string) => console.error(message));
  let values: CliValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({      args: argv,
      allowPositionals: true,
      options: {
        ref: { type: "string" },
        scope: { type: "string", multiple: true },
        language: { type: "string" },
        "env-file": { type: "string" },
        standalone: { type: "boolean", default: false },
        output: { type: "string" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }) as { values: CliValues; positionals: string[] });
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n\n${usage(language)}`);
    return 2;
  }
  if (values.help) {
    stdout(usage(language));
    return 0;
  }
  if (positionals.length !== 1 || (values.language !== undefined && values.language !== "zh-CN" && values.language !== "en")) {
    stderr(usage(language));
    return 2;
  }

  const outputLanguage = values.language as "zh-CN" | "en";
  try {
    const output = values.output ? resolve(values.output) : null;
    if (output && !values.force && await outputExists(output)) throw new SnapshotCliError("output_exists", output);
    const environment: Record<string, string | undefined> = { ...(dependencies.environment ?? process.env) };
    if (values["env-file"]) {
      const parsed = parseEnvironmentFile(await readFile(resolve(values["env-file"]), "utf8"));
      for (const key of ["AI_BASE_URL", "AI_API_KEY", "AI_MODEL"] as const) {
        if (environment[key] === undefined && parsed[key] !== undefined) environment[key] = parsed[key];
      }
    }
    stderr(language === "en" ? `Analyzing snapshot: ${positionals[0]}` : `正在分析快照：${positionals[0]}`);
    const host = environment.CODELPHI_SKILL_HOST?.trim();
    const standalone = values.standalone === true || Boolean(values["env-file"]);
    const aiSource = host && !standalone ? `${host} current model` : standaloneGatewayHost(environment);
    stderr(language === "en" ? `AI source: ${aiSource}` : `AI 来源：${aiSource}`);
    const run = dependencies.run ?? runSnapshot;
    const result = await run({
      target: positionals[0],
      ref: values.ref,
      scopeRoots: scopeRoots(values.scope),
      outputLanguage,
      environment,
      standalone,
      onProgress: progressReporter(outputLanguage, stderr),
      ...(host ? { hostContext: { host } } : {}),
    });
    const destination = output ?? defaultOutputPath(result);
    if (!output && !values.force && await outputExists(destination)) throw new SnapshotCliError("output_exists", destination);
    await writeReportAtomically(destination, result.html, values.force === true);
    stdout(language === "en" ? `Snapshot report written to ${destination}` : `快照报告已生成：${destination}`);
    return 0;
  } catch (error) {
    stderr(errorText(error, outputLanguage));
    return 1;
  }
}

if (process.argv[1] && /snapshot\.(?:ts|cjs)$/.test(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
