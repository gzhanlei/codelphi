import { intlLocale, type UiLocale } from "./ui-locale";

/** locale 感知的日期格式化（替换硬编码 zh-CN）：服务器组件预格式化为字符串再下发，
 *  客户端不重复格式化，杜绝 hydration mismatch。 */
export function formatDateIn(locale: UiLocale, value: unknown, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(intlLocale(locale), options ?? { dateStyle: "medium" }).format(date);
}

export function formatDateTimeIn(locale: UiLocale, value: unknown): string {
  return formatDateIn(locale, value, { dateStyle: "medium", timeStyle: "short" });
}
