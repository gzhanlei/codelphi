import { cookies } from "next/headers";
import { resolveUiLocaleValue, UI_LOCALE_COOKIE, type UiLocale } from "./ui-locale";

/** 服务端组件读取界面语言 cookie（仅供 server component / route 使用；
 *  客户端组件通过 props 接收 locale，防止 next/headers 进入 client bundle）。 */
export async function resolveUiLocale(jar?: { get(name: string): { value: string } | undefined }): Promise<UiLocale> {
  const store = jar ?? (await cookies());
  return resolveUiLocaleValue(store.get(UI_LOCALE_COOKIE)?.value);
}
