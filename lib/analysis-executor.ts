import { defaultExecute, type Execute } from "./db";

/**
 * 谁来分析（修订稿 §6「本地分析与托管的隔离」）。
 *
 * products.analysis_executor：server 是托管分析，client 是租户的客户端分析。
 * 产品是 client 时，服务端不读源码、不调模型，托管分析的任何入口都不得启动。
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

/** 读一个仓库所属的产品由谁来分析。读不到（仓库不存在）按托管算，让调用方原有的检查去报错。 */
export async function loadAnalysisExecutor(repositoryId: number, execute: Execute = defaultExecute): Promise<AnalysisExecutor> {
  const result = await execute(
    "SELECT p.analysis_executor AS analysisExecutor FROM repositories repo JOIN products p ON p.id = repo.product_id WHERE repo.id = ?",
    [repositoryId],
  );
  const rows = (Array.isArray(result) ? (result[0] as Array<{ analysisExecutor?: string }>) : []);
  return rows[0]?.analysisExecutor === "client" ? "client" : "server";
}

/** 托管分析的统一入口都要过这一关：产品由客户端分析就拒绝，而且是在动任何别的表之前。 */
export async function assertServerExecuted(repositoryId: number, execute: Execute): Promise<void> {
  if ((await loadAnalysisExecutor(repositoryId, execute)) === "client") throw new ClientAnalysisError();
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
