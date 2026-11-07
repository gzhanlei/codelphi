import { z } from "zod";
import { codeHostingProviderSchema } from "./code-hosting/types";

export const productInputSchema = z.object({
  name: z.string().trim().min(1, "请输入产品名称").max(100, "产品名称过长"),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug 只能包含小写字母、数字和单个连字符").max(64),
  description: z.string().trim().max(1_000, "产品简介不能超过 1000 字").default(""),
  repository: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "仓库格式应为 owner/repo"),
  provider: codeHostingProviderSchema.default("github"),
  defaultBranch: z.string().trim().max(191).regex(/^[^\s~^:?*\\]*$/, "分支名称包含无效字符").default(""),
  analyze: z.boolean().default(true),
  connectionId: z.number().int().positive().nullable().default(null),
});

export const descriptionUpdateSchema = z.object({
  description: z.string().max(1_000, "产品简介不能超过 1000 字"),
});

/** PATCH /api/products/[slug]：改名 / 改 slug / 改概况 / 公开演示开关，至少提供一项。 */
export const productUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "请输入产品名称").max(100, "产品名称过长").optional(),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug 只能包含小写字母、数字和单个连字符").max(64).optional(),
    description: z.string().max(1_000, "产品简介不能超过 1000 字").optional(),
    isPublicDemo: z.boolean().optional(),
  })
  .refine((data) => data.name !== undefined || data.slug !== undefined || data.description !== undefined || data.isPublicDemo !== undefined, "请提供要修改的内容");

export function slugifyProductName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
}

export function nextProductSlug(name: string, current: string, edited: boolean) {
  return edited ? current : slugifyProductName(name);
}

export function defaultConnectionId(connections: Array<{ id: number }>) {
  return connections[0]?.id || null;
}
