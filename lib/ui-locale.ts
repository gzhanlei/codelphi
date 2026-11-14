/**
 * 界面语言（与分析输出语言相互独立）：cookie 驱动的服务端渲染 locale。
 * 服务器组件直接 resolveUiLocale() 读取（与 session cookie 同管线），客户端组件
 * 通过 props 接收已解析的 locale——两端口径一致，无 hydration mismatch。
 * 存量页面未迁移时缺省 zh-CN，逐页迁移（Wave 4）。
 */
export type UiLocale = "zh-CN" | "en";

export const UI_LOCALE_COOKIE = "codelphi_locale";

export const UI_LOCALES: UiLocale[] = ["zh-CN", "en"];

/** 语言自名（中文/English）：两种界面语言下都可读，切换器直接用。 */
export const UI_LOCALE_LABELS: Record<UiLocale, string> = {
  "zh-CN": "中文",
  en: "English",
};

export function resolveUiLocaleValue(value: string | undefined | null): UiLocale {
  return value === "en" ? "en" : "zh-CN";
}

/** 服务端读取入口在 ./ui-locale-server（next/headers 依赖不得进 client bundle）。 */

/** 双语字典条目形态：键即 locale（与 regression-task-view 的 label-map 同构）。 */
export type LocaleEntry = Record<UiLocale, string>;

export function pick(locale: UiLocale, entry: LocaleEntry): string {
  return entry[locale];
}

/** locale 的 Intl 代码（日期格式化用）。 */
export function intlLocale(locale: UiLocale): string {
  return locale;
}
