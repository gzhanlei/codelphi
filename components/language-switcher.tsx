"use client";

import { useState } from "react";
import { UI_LOCALES, UI_LOCALE_COOKIE, UI_LOCALE_LABELS, type UiLocale } from "@/lib/ui-locale";

/**
 * 界面语言切换器（顶栏显眼 pill）：两种语言自名直呼。
 * cookie 非 HttpOnly——客户端直写 document.cookie 后整页 reload：语言切换天然是
 * 整页文案替换，reload 是确定性路径（router.refresh 的 RSC 缓存语义在部分页面
 * 不会重渲染，实测不切）。服务端 /api/ui-locale 保留作无 JS 回退。
 */
export function LanguageSwitcher({ locale }: { locale: UiLocale }) {
  const [pending, setPending] = useState(false);

  const switchTo = (next: UiLocale) => {
    if (next === locale || pending) return;
    setPending(true);
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${UI_LOCALE_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax${secure}`;
    window.location.reload();
  };

  return (
    <div className="language-switcher" role="group" aria-label={locale === "en" ? "Interface language" : "界面语言"} style={{ display: "inline-flex", gap: 2, border: "1px solid var(--border, #d4d4d8)", borderRadius: 999, padding: 2 }}>
      {UI_LOCALES.map((item) => (
        <button
          key={item}
          type="button"
          data-locale={item}
          aria-pressed={item === locale}
          disabled={pending}
          onClick={() => switchTo(item)}
          style={{
            fontSize: 12,
            padding: "2px 10px",
            borderRadius: 999,
            border: "none",
            cursor: pending ? "wait" : "pointer",
            background: item === locale ? "var(--accent, #18181b)" : "transparent",
            color: item === locale ? "#fff" : "inherit",
            fontWeight: item === locale ? 650 : 400,
          }}
        >
          {UI_LOCALE_LABELS[item]}
        </button>
      ))}
    </div>
  );
}
