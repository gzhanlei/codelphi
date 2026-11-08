import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chandlerBaseUrl, requiredEnv } from "./env";

/**
 * Chandler 支付 API client（M3-T2；状态机契约 §2/§3/§4，AIRecord client.py 为参考实现）：
 * - 建单/退款走服务端 Apikey（CHANDLER_API_KEY，key 属主持 owner/admin/finance）；prepay/查单走用户 token；
 * - 建单幂等键 = 本地商户单号；退款幂等键 = refund-{platform_order_no}；
 * - 退款金额必填且为正数（分）——Chandler 无「缺省全额」语义；
 * - webhook 验签 = hex(HMAC-SHA256(raw_body, key))，key 默认 sha256_hex(client_secret)。
 */

export interface PrepayParams {
  codeUrl?: string | null;
  payUrl?: string | null;
  h5Url?: string | null;
}

export interface RemoteOrderState {
  status: string;
}

export interface CreateOrderInput {
  orderNo: string;
  channel: "wechat" | "alipay";
  amount: number;
  currency: string;
  subject: string;
  source: string;
}

function unwrapEnvelope(value: unknown): unknown {
  if (typeof value === "object" && value !== null && "data" in value) return (value as { data: unknown }).data;
  return value;
}

async function chandlerRequest(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${chandlerBaseUrl()}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  if (!response.ok) {
    // 透传平台业务错误码（payment.* / catalog.* 等）供路由层决定 409 语义
    const error = new Error(`chandler ${path} failed (${response.status}): ${text.slice(0, 500)}`);
    (error as { chandlerStatus?: number; chandlerBody?: unknown }).chandlerStatus = response.status;
    try {
      (error as { chandlerBody?: unknown }).chandlerBody = JSON.parse(text);
    } catch {
      (error as { chandlerBody?: unknown }).chandlerBody = text;
    }
    throw error;
  }
  return unwrapEnvelope(text ? JSON.parse(text) : null);
}

function apikeyHeader(): Record<string, string> {
  return { Authorization: `Apikey ${requiredEnv("CHANDLER_API_KEY")}` };
}

/** 建单（服务端 Apikey 鉴权；Idempotency-Key = 本地商户单号——同单重放返回原平台单）。 */
export async function createChandlerOrder(input: CreateOrderInput, userToken: string): Promise<{ platformOrderNo: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Idempotency-Key": input.orderNo };
  if (process.env.CHANDLER_API_KEY?.trim()) Object.assign(headers, apikeyHeader());
  else Object.assign(headers, { Authorization: `Bearer ${userToken}` });
  const payload = (await chandlerRequest("/v1/pay/orders", {
    method: "POST",
    headers,
    body: JSON.stringify({
      application_id: requiredEnv("CHANDLER_CLIENT_ID"),
      merchant_order_no: input.orderNo,
      channel: input.channel,
      amount: input.amount,
      currency: input.currency,
      subject: input.subject,
      source: input.source,
    }),
  })) as { platform_order_no?: unknown; id?: unknown };
  const platformOrderNo = payload.platform_order_no ?? payload.id;
  if (typeof platformOrderNo !== "string" || !platformOrderNo) {
    throw new Error("chandler create_order returned no platform order number");
  }
  return { platformOrderNo };
}

/** 预支付（用户 token；返回微信扫码/H5 与支付宝跳转参数）。 */
export async function prepayChandlerOrder(platformOrderNo: string, userToken: string): Promise<PrepayParams> {
  const payload = (await chandlerRequest(`/v1/pay/orders/${platformOrderNo}/prepay`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userToken}` },
  })) as Record<string, unknown>;
  return {
    codeUrl: typeof payload.code_url === "string" ? payload.code_url : null,
    payUrl: typeof payload.pay_url === "string" ? payload.pay_url : null,
    h5Url: typeof payload.h5_url === "string" ? payload.h5_url : null,
  };
}

/** 查单（用户 token；对账用）。 */
export async function queryChandlerOrder(platformOrderNo: string, userToken: string): Promise<RemoteOrderState> {
  const payload = (await chandlerRequest(`/v1/pay/orders/${platformOrderNo}`, {
    headers: { Authorization: `Bearer ${userToken}` },
  })) as Record<string, unknown>;
  return { status: typeof payload.status === "string" ? payload.status : "unknown" };
}

/**
 * 退款（服务端 Apikey；幂等键 refund-{platform_order_no}）。
 * 金额必填正数（分）——Chandler 无「缺省全额」语义；调用方折算后传入。
 */
export async function refundChandlerOrder(input: { platformOrderNo: string; amount: number; reason: string }): Promise<void> {
  await chandlerRequest("/v1/me/refunds", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...apikeyHeader(), "Idempotency-Key": `refund-${input.platformOrderNo}` },
    body: JSON.stringify({
      client_id: requiredEnv("CHANDLER_CLIENT_ID"),
      platform_order_no: input.platformOrderNo,
      amount: input.amount,
      reason: input.reason,
    }),
  });
}

/** webhook 验签：hex(HMAC-SHA256(raw_body, key))，恒时比较；key 默认 sha256_hex(client_secret)。 */
export function verifyChandlerWebhookSignature(rawBody: string, signature: string | null): boolean {
  const explicit = process.env.CHANDLER_WEBHOOK_API_KEY?.trim();
  const clientSecret = process.env.CHANDLER_CLIENT_SECRET?.trim() ?? "";
  // 平台约定（文档 v3.1 §7.4 / AIRecord 生产口径）：key = sha256_hex(client_secret)
  const keySource = explicit || (clientSecret ? createHash("sha256").update(clientSecret).digest("hex") : "");
  if (!keySource || !signature) return false;
  const expected = createHmac("sha256", keySource).update(rawBody, "utf8").digest("hex");
  const provided = signature.trim();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}

export interface ChandlerWebhookPayload {
  platformOrderNo: string;
  status: string;
}

export function parseChandlerWebhookPayload(rawBody: string): ChandlerWebhookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const orderNo = (parsed as { platform_order_no?: unknown } | null)?.platform_order_no;
  const status = (parsed as { status?: unknown } | null)?.status;
  if (typeof orderNo !== "string" || !orderNo || typeof status !== "string" || !status) return null;
  return { platformOrderNo: orderNo, status };
}
