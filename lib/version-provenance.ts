/**
 * 版本的来源信息（修订稿 §6）：只有客户端分析的版本带它，托管分析的版本那一列是空的。
 * 给页面用的只有「这是客户端分析出来的」和客户端声明的模型名——后者是客户端的说法，页面上要标明。
 */
export interface ClientProvenanceBadge {
  executor: "client";
  model: string;
  clientVersion: string;
}

/** 从 spec_versions.provenance_json 读出来的是什么就是什么；不是客户端分析的版本返回 null。 */
export function clientProvenanceOf(value: unknown): ClientProvenanceBadge | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as { server?: { executor?: unknown }; client?: { model?: unknown; clientVersion?: unknown } };
  if (record.server?.executor !== "client" || typeof record.client?.model !== "string") return null;
  return {
    executor: "client",
    model: record.client.model,
    clientVersion: typeof record.client.clientVersion === "string" ? record.client.clientVersion : "",
  };
}
