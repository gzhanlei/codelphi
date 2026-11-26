/**
 * 版本的来源信息（修订稿 §6）：只有客户端分析的版本带它，托管分析的版本那一列是空的。
 * 有两种。一种是租户用客户端发布出来的：页面上除了「这是客户端分析出来的」，还要给出客户端声明的模型名——
 * 那是客户端的说法，页面上要标明。另一种是从导入的雷达快照回填出来的：导入没有记模型，服务端也没分析过，
 * 页面上要把这两件事都说清楚，不能让它看起来像托管分析，也不能让它看起来像一次客户端发布。
 */

/** 客户端发布出来的版本。 */
export interface ClientProvenanceBadge {
  executor: "client";
  model: string;
  clientVersion: string;
}

/** 由导入的雷达快照回填出来的版本（scripts/backfill-import-draft.ts）。 */
export interface ImportBackfillBadge {
  executor: "client";
  entry: "import_backfill";
}

export type VersionProvenanceBadge = ClientProvenanceBadge | ImportBackfillBadge;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** 从 spec_versions.provenance_json 读出来的是什么就是什么；不是客户端分析的版本返回 null。 */
export function clientProvenanceOf(value: unknown): VersionProvenanceBadge | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!isObject(parsed) || !isObject(parsed.server)) return null;
  const server = parsed.server;
  if (server.executor !== "client") return null;
  // 回填的版本靠 entry 认。只认这一个值：别的值说明是没见过的来源，不猜它是什么，按发布处理要走下面的模型检查。
  if (server.entry === "import_backfill") return { executor: "client", entry: "import_backfill" };
  const client = isObject(parsed.client) ? parsed.client : {};
  if (typeof client.model !== "string") return null;
  return {
    executor: "client",
    model: client.model,
    clientVersion: typeof client.clientVersion === "string" ? client.clientVersion : "",
  };
}
