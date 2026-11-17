import { z } from "zod";
import { codeHostingProviderSchema } from "./code-hosting/types";
import { outputLanguageSchema } from "./analysis-language";

const repositorySegment = "[A-Za-z0-9_.-]+";
/** GitHub/Gitea/Gitee 是两段 owner/repo；GitLab 支持多级 namespace（group/subgroup/project）。 */
const gitlabRepositoryPattern = new RegExp(`^${repositorySegment}(?:/${repositorySegment}){1,9}$`);
const defaultRepositoryPattern = new RegExp(`^${repositorySegment}/${repositorySegment}$`);

export const productInputSchema = z.object({
  name: z.string().trim().min(1, "请输入产品名称").max(100, "产品名称过长"),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug 只能包含小写字母、数字和单个连字符").max(64),
  description: z.string().trim().max(1_000, "产品简介不能超过 1000 字").default(""),
  repository: z.string().trim().regex(new RegExp(`^${repositorySegment}(?:/${repositorySegment})+$`), "仓库格式应为 owner/repo"),
  provider: codeHostingProviderSchema.default("github"),
  defaultBranch: z.string().trim().max(191).regex(/^[^\s~^:?*\\]*$/, "分支名称包含无效字符").default(""),
  analyze: z.boolean().default(true),
  connectionId: z.number().int().positive().nullable().default(null),
  /** 分析输出语言：缺省时注册路径继承工作区默认（organizations.default_output_language）。 */
  outputLanguage: outputLanguageSchema.optional(),
}).superRefine((value, ctx) => {
  // 与 parseGitlabRepository 的多级 namespace 支持对齐；空段（group//project）被拒绝
  const pattern = value.provider === "gitlab" ? gitlabRepositoryPattern : defaultRepositoryPattern;
  if (!pattern.test(value.repository)) {
    ctx.addIssue({ code: "custom", path: ["repository"], message: value.provider === "gitlab" ? "仓库格式应为 owner/repo（GitLab 支持多级 namespace）" : "仓库格式应为 owner/repo" });
  }
});

export const descriptionUpdateSchema = z.object({
  description: z.string().max(1_000, "产品简介不能超过 1000 字"),
});

/** PATCH /api/products/[slug]：改名 / 改 slug / 改概况 / 公开演示开关 / 输出语言，至少提供一项。 */
export const productUpdateSchema = z
  .object({
    name: z.string().trim().min(1, "请输入产品名称").max(100, "产品名称过长").optional(),
    slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug 只能包含小写字母、数字和单个连字符").max(64).optional(),
    description: z.string().max(1_000, "产品简介不能超过 1000 字").optional(),
    isPublicDemo: z.boolean().optional(),
    outputLanguage: outputLanguageSchema.optional(),
  })
  .refine((data) => data.name !== undefined || data.slug !== undefined || data.description !== undefined || data.isPublicDemo !== undefined || data.outputLanguage !== undefined, "请提供要修改的内容");

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
