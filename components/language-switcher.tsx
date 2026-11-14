"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UI_LOCALES, UI_LOCALE_LABELS, type UiLocale } from "@/lib/ui-locale";

/** 界面语言切换器（顶栏显眼 pill）：两种语言自名直呼，点击写 cookie 后刷新当前页。
 *  服务端组件壳里拿不到当前路径，redirectTo 在点击时从 window.location 读取。 */
export function LanguageSwitcher({ locale }: { locale: UiLocale }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const switchTo = async (next: UiLocale) => {
    if (next === locale || pending) return;
    setPending(true);
    try {
      const path = `${window.location.pathname}${window.location.search}`;
      await fetch("/api/ui-locale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next, redirectTo: path || "/" }),
      });
      router.refresh();
    } finally {
      setPending(false);
    }
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
