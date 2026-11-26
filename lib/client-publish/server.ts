/**
 * 客户端和服务端之间的 HTTP（修订稿 §5.2、§5.6）：取上下文、分块上传提案。
 * 鉴权是 Bearer API key（snapshot_write 权限）。Key 只放进请求头，不进日志、不进错误信息。
 */
export interface ServerConfig {
  serverUrl: string;
  key: string;
}

export interface ClientProduct {
  slug: string;
  name: string;
  analysisExecutor: string;
  currentVersionId: number | null;
  currentRevisionSha: string | null;
  repository: { repositoryId: number; provider: string; host: string | null; owner: string | null; name: string | null } | null;
}

/** GET /api/client-analysis/context 的返回。 */
export interface ClientContext {
  contractVersion: string;
  supportedContractVersions: string[];
  minSupportedContractVersion: string;
  organization: { name: string };
  products: ClientProduct[];
}

export interface UploadResult {
  status: number;
  body: Record<string, unknown>;
}

/** 服务端给了明确的拒绝（4xx）。status 和回执原样带给调用方，由它决定怎么办。 */
export class ServerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.name = "ServerRequestError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function baseUrl(server: ServerConfig): string {
  return server.serverUrl.replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function fetchContext(server: ServerConfig, fetchImpl: FetchLike = fetch): Promise<ClientContext> {
  const response = await fetchImpl(`${baseUrl(server)}/api/client-analysis/context`, { headers: { authorization: `Bearer ${server.key}` } });
  const body = await readJson(response);
  if (!response.ok) throw new ServerRequestError(response.status, body);
  return body as unknown as ClientContext;
}

/**
 * 分块上传提案（和 BYO 快照导入同一个协议）：4MB 一片，带 x-import-* 头；每一片都确认上一片已收到，最后一片带回执。
 * 不带分片头就是单发。载荷里没有源码，分块只是为了让 nginx 的请求体上限不成为产品规模的天花板。
 */
export async function uploadProposal(server: ServerConfig, slug: string, payload: string, options: { fetchImpl?: FetchLike; chunkBytes?: number } = {}): Promise<UploadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const buffer = Buffer.from(payload, "utf8");
  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
  const total = Math.max(1, Math.ceil(buffer.length / chunkBytes));
  const importId = randomUploadId();
  const url = `${baseUrl(server)}/api/products/${encodeURIComponent(slug)}/analysis-proposals`;
  for (let index = 0; index < total; index += 1) {
    const slice = buffer.subarray(index * chunkBytes, Math.min(buffer.length, (index + 1) * chunkBytes));
    const headers: Record<string, string> = { "content-type": "application/octet-stream", authorization: `Bearer ${server.key}` };
    if (total > 1) {
      headers["x-import-id"] = importId;
      headers["x-import-chunk-index"] = String(index);
      headers["x-import-chunk-total"] = String(total);
    }
    const response = await fetchImpl(url, { method: "POST", headers, body: new Uint8Array(slice) });
    const body = await readJson(response);
    // 分片的确认（{ received: true }）和最终回执都是 2xx；只有最后一片带 published 的结果。
    if (!response.ok) return { status: response.status, body };
    if (index === total - 1) return { status: response.status, body };
  }
  return { status: 500, body: { error: "upload_incomplete" } };
}

function randomUploadId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
