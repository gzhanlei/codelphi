import { AsyncLocalStorage } from "node:async_hooks";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { defaultExecute, type Execute } from "./db";
import { requiredEnv } from "./env";
import { decryptSecret, encryptSecret } from "./secret-box";

/**
 * 工作区自己的模型配置（产品负责人 2026-11-27 的决定：打开服务端分析开关的产品，必须先让用户填自己的模型配置，
 * CoDelphi 不替用户付模型费用）。
 *
 * 一个工作区一份：模型服务地址、API key、模型名。key 用 AES-256-GCM 加密保存，主密钥和 GitHub 集成的 secret 同一个。
 *
 * 服务端替工作区调用它的模型时，地址是用户填的，所以有三道防护，缺一不可：
 *   1. 只接受 https 的地址，不许带用户名密码，主机不能是 localhost 或内网地址的字面量（assertPublicModelUrl）。
 *   2. 连接之前解析域名，解析出来的每个地址都必须是公网地址（resolvePublicHost）。只查字面量挡不住
 *      「一个公网域名指向内网」。
 *   3. 连接钉在校验过的那些地址上（pinnedLookup）。只做第 2 步的话，校验和连接之间域名还能再变一次。
 * 没有这三道，任何能改设置的人都能让服务器去请求它内网里的服务，再从报错里读应答。
 *
 * 绑定（withOrganizationModel）：服务端为某个工作区干活时，把它的模型配置带在这次干活的范围内，
 * 模型调用的出口（lib/ai.ts）据此决定用谁的 key。工作区没有配置时它不干活，也不退回 CoDelphi 的 key。
 */

/** 模型名最长 64 个字符：llm_call_receipts.model 就这么长，回执里记的是它。 */
export const MODEL_NAME_MAX_LENGTH = 64;

export interface OrganizationModel {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class ModelUrlError extends Error {
  constructor(
    readonly code: "invalid" | "not_https" | "credentials_in_url" | "has_fragment" | "has_query" | "no_host" | "not_public" | "private_address" | "unresolvable",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ModelUrlError";
  }
}

/** 工作区没有模型配置。服务端不为它干活，也不退回 CoDelphi 的 key。 */
export class ModelNotConfiguredError extends Error {
  readonly code = "model_not_configured";

  constructor(organizationId: number) {
    super(`model_not_configured: workspace ${organizationId} has no model configuration of its own`);
    this.name = "ModelNotConfiguredError";
  }
}

/** 不该让服务器连过去的地址段。公网地址不在其中任何一段里。 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32], ["2001:2::", 48], ["2001:db8::", 32], ["2002::", 16],
  ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) NOT_PUBLIC.addSubnet(network, prefix, "ipv6");

/** IPv4 映射的 IPv6 地址（::ffff:a.b.c.d）按里面那个 IPv4 判断。 */
function mappedIPv4Of(address: string): string | null {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match ? match[1] : null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const mapped = mappedIPv4Of(address);
  if (mapped !== null) return isPublicAddress(mapped);
  return !NOT_PUBLIC.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** 地址去掉 IPv6 的方括号和末尾的点，统一成小写。 */
function bareHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.+$/, "").toLowerCase();
}

/** 只认 https、不带用户名密码、没有查询串和片段、主机是公网地址或公网域名的地址。域名解析在连接之前再做一次。 */
export function assertPublicModelUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ModelUrlError("invalid", `"${value.trim().slice(0, 200)}" is not a valid address`);
  }
  if (url.protocol !== "https:") throw new ModelUrlError("not_https", `${url.protocol}// is not allowed; the model service address must start with https://`);
  if (url.username !== "" || url.password !== "") throw new ModelUrlError("credentials_in_url", "the address must not contain a user name or password");
  if (url.hash !== "") throw new ModelUrlError("has_fragment", "the address must not contain a # fragment");
  if (url.search !== "") throw new ModelUrlError("has_query", "the address must not contain a query string");
  if (url.hostname === "") throw new ModelUrlError("no_host", "the address has no host");
  const host = bareHost(url.hostname);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ModelUrlError("not_public", `${host} is not a public host`);
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) throw new ModelUrlError("not_public", `${host} is not a public address`);
  return url;
}

/** 连接之前解析主机，返回校验过的地址。任何一个解析结果不是公网地址就拒绝。字面量地址不解析，直接判断。 */
export async function resolvePublicHost(hostname: string, lookup: LookupFunction = dnsLookup): Promise<string[]> {
  const host = bareHost(hostname);
  if (isIP(host) !== 0) {
    if (!isPublicAddress(host)) throw new ModelUrlError("not_public", `${host} is not a public address`);
    return [host];
  }
  let answers: LookupAddress[];
  try {
    answers = await new Promise<LookupAddress[]>((resolve, reject) => {
      lookup(host, { all: true, verbatim: true }, (error, result) => {
        if (error) reject(error);
        else if (Array.isArray(result)) resolve(result);
        // 要了整张表却只给回一个地址（不是 Node 的 dns.lookup，是别的实现）时，也按一个地址算。
        else if (typeof result === "string") resolve([{ address: result, family: isIP(result) }]);
        else resolve([]);
      });
    });
  } catch (error) {
    throw new ModelUrlError("unresolvable", `could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (answers.length === 0) throw new ModelUrlError("unresolvable", `${hostname} resolves to nothing`);
  const refused = answers.find((answer) => !isPublicAddress(answer.address));
  if (refused) throw new ModelUrlError("private_address", `${hostname} resolves to an address that is not public`);
  return answers.map((answer) => answer.address);
}

/** 给连接用的 lookup：只交出校验过的地址。Node 要哪个协议族就给哪个族的，要整张表也只给这些。 */
export function pinnedLookup(checked: readonly string[]): LookupFunction {
  const allowed = checked.map((address) => ({ address, family: isIP(address) as 4 | 6 }));
  return (_hostname, options, callback) => {
    const family = typeof options?.family === "number" ? options.family : 0;
    const matching = allowed.filter((entry) => family === 0 || entry.family === family);
    const chosen = matching.length > 0 ? matching : allowed;
    if (options?.all) {
      (callback as (error: null, result: LookupAddress[]) => void)(null, chosen);
      return;
    }
    (callback as (error: null, address: string, family: number) => void)(null, chosen[0].address, chosen[0].family);
  };
}

export interface TransportDeps {
  /** 测试注入。生产用 dns.lookup。 */
  lookup?: LookupFunction;
  /** 测试注入。生产用 node:https 的 request。 */
  request?: typeof httpsRequest;
}

/** 向工作区的模型发一个 POST，返回状态码和应答正文。三道防护都在这里做。 */
export async function postToModel(target: string, outgoing: { headers: Record<string, string>; body: string; timeoutMs?: number }, deps: TransportDeps = {}): Promise<{ status: number; body: string }> {
  const url = assertPublicModelUrl(target);
  const checked = await resolvePublicHost(url.hostname, deps.lookup ?? dnsLookup);
  const timeoutMs = outgoing.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const request = deps.request ?? httpsRequest;
    const literal = isIP(bareHost(url.hostname)) !== 0;
    const req = request(url, { method: "POST", headers: outgoing.headers, ...(literal ? {} : { servername: url.hostname }), lookup: pinnedLookup(checked) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`the model provider did not answer within ${timeoutMs} ms (timed out)`)));
    req.on("error", reject);
    req.end(outgoing.body);
  });
}

function secret(): string {
  return requiredEnv("SESSION_SECRET");
}

/** 保存（或替换）一个工作区的模型配置。调用方已经用这份配置真调过一次模型。key 加密后才进库。 */
export async function saveOrganizationModel(
  execute: Execute,
  input: { organizationId: number; baseUrl: string; apiKey: string; model: string; by?: string | null },
): Promise<void> {
  const url = assertPublicModelUrl(input.baseUrl);
  if (input.model.trim().length === 0 || input.model.trim().length > MODEL_NAME_MAX_LENGTH) {
    throw new Error(`the model name must be between 1 and ${MODEL_NAME_MAX_LENGTH} characters`);
  }
  if (input.apiKey.trim() === "") throw new Error("the API key is empty");
  await execute(
    `INSERT INTO organization_models (organization_id, base_url, api_key_encrypted, model, verified_at, created_by)
     VALUES (?, ?, ?, ?, NOW(3), ?)
     ON DUPLICATE KEY UPDATE
       base_url = VALUES(base_url),
       api_key_encrypted = VALUES(api_key_encrypted),
       model = VALUES(model),
       verified_at = NOW(3),
       created_by = VALUES(created_by)`,
    [input.organizationId, url.href, encryptSecret(input.apiKey, secret()), input.model.trim(), input.by ?? null],
  );
}

/** 解密后的配置。没有就返回 null；库里的密文读不出来就报错，不拿别的顶上。 */
export async function loadOrganizationModel(organizationId: number, execute: Execute = defaultExecute): Promise<OrganizationModel | null> {
  const rows = (await execute("SELECT base_url, api_key_encrypted, model FROM organization_models WHERE organization_id = ? LIMIT 1", [organizationId])) as unknown as [Array<{ base_url: string; api_key_encrypted: string; model: string }>, unknown];
  const row = (Array.isArray(rows) ? rows[0] : rows)?.[0] ?? undefined;
  if (!row) return null;
  return { baseUrl: row.base_url, apiKey: decryptSecret(row.api_key_encrypted, secret()), model: row.model };
}

/** 给页面和接口看的：不含 key。 */
export async function describeOrganizationModel(organizationId: number, execute: Execute = defaultExecute): Promise<{ baseUrl: string; model: string; verifiedAt: unknown; updatedAt: unknown } | null> {
  const result = (await execute("SELECT base_url, model, verified_at, updated_at FROM organization_models WHERE organization_id = ? LIMIT 1", [organizationId])) as unknown as [Array<{ base_url: string; model: string; verified_at: unknown; updated_at: unknown }>, unknown];
  const rows = (Array.isArray(result) ? result[0] : result) as Array<{ base_url: string; model: string; verified_at: unknown; updated_at: unknown }>;
  const row = rows[0];
  return row ? { baseUrl: row.base_url, model: row.model, verifiedAt: row.verified_at, updatedAt: row.updated_at } : null;
}

/** 只问有没有。闸门用它，不解密。 */
export async function organizationModelConfigured(execute: Execute, organizationId: number): Promise<boolean> {
  const result = (await execute("SELECT organization_id FROM organization_models WHERE organization_id = ? LIMIT 1", [organizationId])) as unknown as [unknown[], unknown];
  return ((Array.isArray(result) ? result[0] : result) as unknown[]).length > 0;
}

export async function deleteOrganizationModel(organizationId: number, execute: Execute = defaultExecute): Promise<boolean> {
  const result = (await execute("DELETE FROM organization_models WHERE organization_id = ?", [organizationId])) as { affectedRows?: number } | undefined;
  return Number(Array.isArray(result) ? (result[0] as { affectedRows?: number })?.affectedRows : result?.affectedRows) > 0;
}

const scope = new AsyncLocalStorage<OrganizationModel>();

/** 当前这次干活绑定的工作区模型。没有绑定就是 null。 */
export function currentOrganizationModel(): OrganizationModel | null {
  return scope.getStore() ?? null;
}

/** 手里已经有解密后的配置时直接绑定（比如正在验证用户刚填的那一份）。 */
export function bindOrganizationModel<T>(model: OrganizationModel, work: () => T): T {
  return scope.run(model, work);
}

/** 为工作区干活：读一次它的模型配置，带在 work 的整个范围里。工作区没有配置时不干活。 */
export async function withOrganizationModel<T>(organizationId: number, work: () => T, execute: Execute = defaultExecute): Promise<T> {
  const model = await loadOrganizationModel(organizationId, execute);
  if (!model) throw new ModelNotConfiguredError(organizationId);
  return scope.run(model, work);
}
