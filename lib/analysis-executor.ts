import { defaultExecute, type Execute } from "./db";

/**
 * 谁来分析（修订稿 §6「本地分析与托管的隔离」），以及用谁的模型（产品负责人 2026-11-27 的决定：
 * 打开服务端分析开关的产品，必须先让用户填自己的模型配置，CoDelphi 不替用户付模型费用）。
 *
 * products.analysis_executor：server 是托管分析，client 是租户的客户端分析。
 * 产品是 client 时，服务端不读源码、不调模型，托管分析的任何入口都不得启动。
 * 产品是 server 时，它的工作区必须有自己的模型配置（organization_models），服务端才为它调模型。
 * 判断只在这一处：入队的两个函数和 runAnalysis 都来问它，恢复与补跑的查询带上这里的条件。
 */
export type AnalysisExecutor = "server" | "client";

/** 客户端发布的 run 的 trigger_type。它只是一张回执：只在发布事务里创建，提交时就是 succeeded，服务端从不执行。 */
export const CLIENT_UPLOAD_TRIGGER = "client_upload";
/** 导入草稿回填的 run 的 trigger_type（scripts/backfill-import-draft.ts）。同样是回执，同样从不执行。 */
export const IMPORT_BACKFILL_TRIGGER = "import_backfill";

/** 回执类 run：一个事务里建行、写完、标成功，外界从来看不到它排队或运行；服务端没有任何执行它的代码。 */
const RECEIPT_OF: Readonly<Record<string, string>> = {
  [CLIENT_UPLOAD_TRIGGER]: "a client publish",
  [IMPORT_BACKFILL_TRIGGER]: "an import backfill",
};

export function isReceiptTrigger(triggerType: string | null): boolean {
  return triggerType !== null && Object.hasOwn(RECEIPT_OF, triggerType);
}

export const CLIENT_MODE_ERROR = "analysis_mode_is_client";

/** 手动分析、补分析的接口拒绝时给用户看的一句话。 */
export const CLIENT_MODE_RESPONSE_MESSAGE = "这个产品由客户端分析：请在本地运行 CoDelphi 客户端的发布命令。服务端不再为它运行托管分析。";

/** 产品由客户端分析时，托管分析的入口抛这个。路由层映射成 409。 */
export class ClientAnalysisError extends Error {
  readonly code = CLIENT_MODE_ERROR;

  constructor(message = "this product is analysed by the client; the server does not run analyses for it") {
    super(message);
    this.name = "ClientAnalysisError";
  }
}

export const MODEL_NOT_CONFIGURED = "model_not_configured";

/**
 * 产品由服务端分析，但它的工作区没有自己的模型配置。CoDelphi 不替用户付模型费用，
 * 所以服务端不为它调模型。入队的闸门、执行的检查和 lib/organization-model.ts 都抛这一个。路由层映射成 409。
 */
export class ModelNotConfiguredError extends Error {
  readonly code = MODEL_NOT_CONFIGURED;

  constructor(message = MODEL_NOT_CONFIGURED_MESSAGE) {
    super(message);
    this.name = "ModelNotConfiguredError";
  }
}

const MODEL_NOT_CONFIGURED_MESSAGE = "model_not_configured: this product is analysed on the server, but its workspace has no model configuration of its own; the server does not pay for its model calls";

/** 接口拒绝时给用户看的一句话。 */
export const MODEL_NOT_CONFIGURED_RESPONSE_MESSAGE = "这个产品由服务端分析，分析要用工作区自己的模型。请先在设置页的「模型配置」里填写模型服务地址、API Key 和模型名。";

/** 服务端因为工作区没有模型而拒绝执行时写进 run 的原因。 */
export function modelRunRefusal(): string {
  return MODEL_NOT_CONFIGURED_MESSAGE;
}

export interface ExecutionMode {
  triggerType: string | null;
  executor: AnalysisExecutor;
}

/** 一个 run 该不该由服务端执行。回执类的 run、客户端分析的产品的 run，都不该。 */
export function serverMayExecute(mode: ExecutionMode): boolean {
  return !isReceiptTrigger(mode.triggerType) && mode.executor !== "client";
}

/** 服务端拒绝执行时写进 run 的原因。 */
export function clientRunRefusal(mode: ExecutionMode): string {
  const receipt = mode.triggerType !== null ? RECEIPT_OF[mode.triggerType] : undefined;
  return receipt
    ? `${CLIENT_MODE_ERROR}: a ${mode.triggerType} run is the receipt of ${receipt} and is never executed by the server`
    : `${CLIENT_MODE_ERROR}: this product is analysed by the client; the server does not run its analyses`;
}

/** 「产品所属的工作区有自己的模型配置」。查询里 products 的别名固定叫 p。 */
export const MODEL_CONFIGURED_SQL = "EXISTS(SELECT 1 FROM organization_models m WHERE m.organization_id = p.organization_id)";

export interface AnalysisMode {
  executor: AnalysisExecutor;
  /** 工作区有没有自己的模型配置。 */
  modelConfigured: boolean;
}

/**
 * 一条查询同时回答两件事：产品由谁来分析，它的工作区有没有自己的模型。
 * 读不到（仓库不存在）按托管、没有模型算，让调用方原有的检查去报错。
 */
export async function loadAnalysisMode(repositoryId: number, execute: Execute = defaultExecute): Promise<AnalysisMode> {
  const result = await execute(
    `SELECT p.analysis_executor AS analysisExecutor, ${MODEL_CONFIGURED_SQL} AS modelConfigured FROM repositories repo JOIN products p ON p.id = repo.product_id WHERE repo.id = ?`,
    [repositoryId],
  );
  const rows = (Array.isArray(result) ? (result[0] as Array<{ analysisExecutor?: string; modelConfigured?: unknown }>) : []);
  return { executor: rows[0]?.analysisExecutor === "client" ? "client" : "server", modelConfigured: Number(rows[0]?.modelConfigured ?? 0) === 1 };
}

/** 读一个仓库所属的产品由谁来分析。 */
export async function loadAnalysisExecutor(repositoryId: number, execute: Execute = defaultExecute): Promise<AnalysisExecutor> {
  return (await loadAnalysisMode(repositoryId, execute)).executor;
}

/**
 * 托管分析的统一入口都要过这一关，而且是在动任何别的表之前：
 * 产品由客户端分析就拒绝；产品由服务端分析、但工作区没有自己的模型，也拒绝。
 */
export async function assertServerExecuted(repositoryId: number, execute: Execute): Promise<void> {
  const mode = await loadAnalysisMode(repositoryId, execute);
  if (mode.executor === "client") throw new ClientAnalysisError();
  if (!mode.modelConfigured) throw new ModelNotConfiguredError();
}

/**
 * 把一个产品改成由客户端或服务端分析。改成服务端分析时，它的工作区必须先有自己的模型配置：
 * 界面上没配模型就不给选「服务端分析」，这里是绕过界面时也躲不过的那一道（之后入队和执行还各有一道）。
 */
export async function switchAnalysisExecutor(productId: number, executor: AnalysisExecutor, execute: Execute = defaultExecute): Promise<void> {
  if (executor === "server") {
    const result = await execute(`SELECT ${MODEL_CONFIGURED_SQL} AS modelConfigured FROM products p WHERE p.id = ?`, [productId]);
    const rows = (Array.isArray(result) ? (result[0] as Array<{ modelConfigured?: unknown }>) : []);
    if (!rows[0]) throw new Error(`product ${productId} not found`);
    if (Number(rows[0].modelConfigured) !== 1) throw new ModelNotConfiguredError();
  }
  await execute("UPDATE products SET analysis_executor = ? WHERE id = ?", [executor, productId]);
}

/** 这个工作区里还在用服务端分析的产品。删工作区的模型配置之前要问它：删了，这些产品就分析不了了。 */
export async function serverAnalysedProducts(organizationId: number, execute: Execute = defaultExecute): Promise<string[]> {
  const result = await execute("SELECT p.slug FROM products p WHERE p.organization_id = ? AND p.analysis_executor = 'server' ORDER BY p.id", [organizationId]);
  const rows = (Array.isArray(result) ? (result[0] as Array<{ slug: string }>) : []);
  return rows.map((row) => row.slug);
}

/**
 * 恢复与补跑的候选查询、启动时的重排语句都要带上这段条件：不归服务端执行的 run 不被捞出来。
 * 查询里 analysis_runs 的别名由调用方给，repositories 固定叫 repo、products 固定叫 p。
 */
export function serverExecutedRunSql(runAlias = "r"): string {
  return `${runAlias}.trigger_type ${NOT_RECEIPT_SQL} AND p.analysis_executor <> 'client'`;
}

const NOT_RECEIPT_SQL = `NOT IN (${Object.keys(RECEIPT_OF).map((trigger) => `'${trigger}'`).join(", ")})`;

/** 给不带头表的 analysis_runs 语句用的等价条件。 */
export const SERVER_EXECUTED_RUN_UNJOINED_SQL = `trigger_type ${NOT_RECEIPT_SQL}
       AND repository_id NOT IN (SELECT repo.id FROM repositories repo JOIN products p ON p.id = repo.product_id WHERE p.analysis_executor = 'client')`;
