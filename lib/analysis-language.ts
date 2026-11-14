import { z } from "zod";
import type { Execute } from "./db";

/**
 * 分析输出语言（产品级设置）：AI 提取的功能/场景/摘要/发布稿文本按此语言生成。
 * 语言名用各自语言自述（中文 / English），两种界面语言下都可直接展示。
 * 注册时可选，缺省继承工作区默认（organizations.default_output_language）；
 * 语言切换后首个 run 强制全量重建（spec_versions.output_language 记录每版语言）。
 */
export type OutputLanguage = "zh-CN" | "en";

export const DEFAULT_OUTPUT_LANGUAGE: OutputLanguage = "zh-CN";

export const outputLanguageSchema = z.enum(["zh-CN", "en"]);

export const OUTPUT_LANGUAGE_LABELS: Record<OutputLanguage, string> = {
  "zh-CN": "中文（简体）",
  en: "English",
};

/** 设置面板提示文案（中文界面阶段先出中文，Wave 3/4 界面双语时统一迁移）。 */
export const OUTPUT_LANGUAGE_HINTS: Record<OutputLanguage, string> = {
  "zh-CN": "功能规格、场景与发布稿将以简体中文生成",
  en: "Feature specs, scenarios and release notes will be generated in English",
};

/** 读产品输出语言（发布稿改写等异步生成通道用）：非法/缺省一律回退 zh-CN。 */
export async function loadProductOutputLanguage(productId: number, execute: Execute): Promise<OutputLanguage> {
  const result = await execute("SELECT output_language AS outputLanguage FROM products WHERE id = ?", [productId]);
  const rows = (Array.isArray(result) ? (result as unknown[])[0] : result) as Array<{ outputLanguage?: string }>;
  return rows?.[0]?.outputLanguage === "en" ? "en" : "zh-CN";
}
