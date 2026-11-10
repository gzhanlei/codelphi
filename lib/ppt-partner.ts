import { pptPartnerConfig, type PptPartnerConfig } from "./env";

/**
 * PPTCreator（easymakeppt）partner MCP 薄客户端（GTM 桥面批次 2）。
 * 契约：Streamable HTTP MCP，单条 JSON-RPC 请求/JSON 响应；工具结果在
 * result.content[0].text 里承载业务 JSON（对端 lib/mcp/partner-dev-client.ts parseMcpToolBody 同构）。
 * 任务模型：create_ppt_from_documents(confirmed_outline + stage=pptx) 入队（X-Job-Id 幂等）
 * → get_generation_status 轮询（终态 COMPLETED/FAILED）→ get_download_url 取 5 分钟预签名链接。
 */

export interface PptOutlineSlide {
  order: number;
  type: "COVER" | "CONTENT" | "SECTION_HEADER" | "BACK_COVER" | "QUOTE";
  title: string;
  chapter?: string;
  keyPoints?: string[];
  notes?: string;
}

export type PptJobStatus = "queued" | "GENERATING" | "OUTLINE_READY" | "COMPLETED" | "FAILED" | string;

export interface PptJobSnapshot {
  projectId: string;
  status: PptJobStatus;
  pptxUrl?: string | null;
  error?: string | null;
  message?: string | null;
}

export class PptPartnerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function partnerHeaders(config: PptPartnerConfig, jobId: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-partner-key": config.key,
    "x-job-id": jobId,
  };
  if (config.orgId) headers["x-org-id"] = config.orgId;
  if (config.memberId) headers["x-member-id"] = config.memberId;
  return headers;
}

/** JSON-RPC tools/call 单发：解析 result.content[0].text 的业务 JSON；错误码原样上抛。 */
async function callTool(config: PptPartnerConfig, jobId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: "POST",
      headers: partnerHeaders(config, jobId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw new PptPartnerError("partner_unreachable", error instanceof Error ? error.message : "PPT 服务不可达");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (payload === null || typeof payload !== "object") {
    throw new PptPartnerError("invalid_response", `PPT 服务返回不可解析（HTTP ${response.status}）`);
  }
  const root = payload as { error?: unknown; result?: unknown };
  if (root.error && root.result === undefined) {
    const err = root.error as { code?: unknown; message?: unknown };
    throw new PptPartnerError(String(err.code ?? "jsonrpc_error"), String(err.message ?? "PPT 服务调用失败"));
  }
  const result = (root.result ?? {}) as { isError?: boolean; content?: unknown };
  const content = Array.isArray(result.content) ? (result.content[0] as { text?: unknown } | undefined) : undefined;
  if (typeof content?.text !== "string") {
    throw new PptPartnerError("empty_result", "PPT 服务响应无文本载荷");
  }
  let data: unknown;
  try {
    data = JSON.parse(content.text);
  } catch {
    throw new PptPartnerError("invalid_json", content.text.slice(0, 200));
  }
  const record = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  if (result.isError || record.error !== undefined) {
    const err = record.error as { code?: unknown; message?: unknown } | undefined;
    throw new PptPartnerError(String(err?.code ?? record.error ?? "error"), String(record.message ?? err?.message ?? record.error ?? "PPT 任务失败"));
  }
  return record;
}

export function requirePptPartnerConfig(): PptPartnerConfig {
  const config = pptPartnerConfig();
  if (!config) throw new PptPartnerError("not_configured", "PPT 服务未配置（缺 PPT_PARTNER_KEY），请联系部署方");
  return config;
}

/**
 * 提交锁脊烧片任务。documents 必须含恰好一份 textbook（≥10 字符）——传事实清单 markdown；
 * confirmed_outline 页面权威（对端 assertConfirmedSpinePreserved 逐字锁定）。
 */
export async function createPptJob(config: PptPartnerConfig, input: { jobId: string; title: string; factsMarkdown: string; outline: PptOutlineSlide[] }): Promise<PptJobSnapshot> {
  const data = await callTool(config, input.jobId, "create_ppt_from_documents", {
    title: input.title,
    documents: [{ role: "textbook", name: `${input.title} · 事实清单`, content: input.factsMarkdown }],
    confirmed_outline: input.outline,
    stage: "pptx",
    language: "zh",
  });
  return {
    projectId: String(data.project_id ?? ""),
    status: String(data.status ?? "queued"),
    message: typeof data.message === "string" ? data.message : null,
  };
}

export async function getPptJobStatus(config: PptPartnerConfig, jobId: string, projectId: string): Promise<PptJobSnapshot> {
  const data = await callTool(config, jobId, "get_generation_status", { project_id: projectId });
  const urls = (data.urls ?? {}) as { pptx_url?: unknown };
  const error = data.error as { code?: unknown; message?: unknown } | undefined;
  return {
    projectId,
    status: String(data.status ?? ""),
    pptxUrl: typeof urls.pptx_url === "string" ? urls.pptx_url : typeof data.pptx_url === "string" ? (data.pptx_url as string) : null,
    error: error ? `${String(error.code ?? "failed")}: ${String(error.message ?? "")}` : null,
    message: typeof data.message === "string" ? data.message : null,
  };
}

/** 取新鲜下载链接（预签名 5 分钟有效，不能久存）。 */
export async function getPptDownload(config: PptPartnerConfig, jobId: string, projectId: string): Promise<{ url: string; filename?: string | null }> {
  const data = await callTool(config, jobId, "get_download_url", { project_id: projectId });
  const url = data.url ?? data.download_url ?? data.pptx_url;
  if (typeof url !== "string" || !url) throw new PptPartnerError("no_download", "PPT 尚无可下载文件");
  return { url, filename: typeof data.filename === "string" ? data.filename : null };
}
