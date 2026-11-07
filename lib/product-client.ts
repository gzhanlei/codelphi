import type { z } from "zod";
import type { productInputSchema } from "./product-input";

type ProductInput = z.infer<typeof productInputSchema>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function productResponse<T extends { error?: string }>(response: Response, fallback: string) {
  const data = await response.json() as T;
  if (!response.ok) throw new Error(data.error ?? fallback);
  return data;
}

export async function createProduct(input: ProductInput, fetcher: Fetcher = fetch) {
  const response = await fetcher("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await productResponse<{ slug?: string; error?: string }>(response, "添加产品失败");
  if (!data.slug) throw new Error(data.error ?? "添加产品失败");
  return data.slug;
}

export async function deleteProduct(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}`, { method: "DELETE" });
  const data = await productResponse<{ status?: string; error?: string }>(response, "移除产品失败");
  if (data.status !== "deleted") throw new Error(data.error ?? "移除产品失败");
  return "deleted" as const;
}

export async function updateDescription(slug: string, description: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });
  const data = await productResponse<{ status?: string; error?: string }>(response, "保存产品概况失败");
  if (data.status !== "updated") throw new Error(data.error ?? "保存产品概况失败");
  return "updated" as const;
}

/** 改产品名 / slug；slug 变化时返回新地址，调用方据此跳转。 */
export async function renameProduct(slug: string, input: { name?: string; slug?: string }, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await productResponse<{ status?: string; slug?: string; error?: string }>(response, "保存产品信息失败");
  if (data.status !== "updated" || !data.slug) throw new Error(data.error ?? "保存产品信息失败");
  return data.slug;
}

export async function setPublicDemo(slug: string, isPublicDemo: boolean, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isPublicDemo }),
  });
  const data = await productResponse<{ status?: string; error?: string }>(response, "保存公开演示设置失败");
  if (data.status !== "updated") throw new Error(data.error ?? "保存公开演示设置失败");
  return "updated" as const;
}

export interface MemberEntry { userId: number; displayName: string; email: string; role: string }
export interface InvitationEntry { id: number; email: string; role: string; expiresAt: string | Date | null }
export interface MemberRoster { organizationMembers: MemberEntry[]; productMembers: MemberEntry[]; invitations: InvitationEntry[] }

export async function listMembers(slug: string, fetcher: Fetcher = fetch): Promise<MemberRoster> {
  const response = await fetcher(`/api/products/${slug}/members`);
  const data = await productResponse<MemberRoster & { error?: string }>(response, "加载成员列表失败");
  return { organizationMembers: data.organizationMembers ?? [], productMembers: data.productMembers ?? [], invitations: data.invitations ?? [] };
}

export async function inviteMember(slug: string, input: { email: string; role: string }, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return productResponse<{ status?: string; inviteUrl?: string; emailSent?: boolean; error?: string }>(response, "邀请失败");
}

export async function removeMember(slug: string, userId: number, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/members/${userId}`, { method: "DELETE" });
  const data = await productResponse<{ status?: string; error?: string }>(response, "移除成员失败");
  if (data.status !== "removed") throw new Error(data.error ?? "移除成员失败");
  return "removed" as const;
}

export async function cancelInvitation(slug: string, invitationId: number, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/invitations/${invitationId}`, { method: "DELETE" });
  const data = await productResponse<{ status?: string; error?: string }>(response, "取消邀请失败");
  if (data.status !== "cancelled") throw new Error(data.error ?? "取消邀请失败");
  return "cancelled" as const;
}

export async function requestAnalysis(slug: string, fetcher: Fetcher = fetch) {
  const response = await fetcher(`/api/products/${slug}/analyze`, { method: "POST" });
  const data = await productResponse<{ runId?: number; error?: string }>(response, "分析请求失败");
  return data.runId;
}
