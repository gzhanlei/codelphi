"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/error-message";
import { pick, type UiLocale } from "@/lib/ui-locale";
import { PUBLIC_DEMO } from "@/lib/ui-strings/workspace";
import { setPublicDemo } from "@/lib/product-client";

/** 设置页 · 公开演示：开启后任何拿到链接的人都能匿名查看该产品全部内容。 */
export function PublicDemoSettings({ slug, enabled, canManage, locale = "zh-CN" }: { slug: string; enabled: boolean; canManage: boolean; locale?: UiLocale }) {
  const L = PUBLIC_DEMO;
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  if (!canManage) return null;

  const toggle = async () => {
    setPending(true);
    setError("");
    try {
      await setPublicDemo(slug, !enabled);
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "保存公开演示设置失败"));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="overview-panel settings-panel">
      <div className="overview-panel-heading"><span>02</span><h2>{pick(locale, L.heading)}</h2></div>
      <p className="overview-note">{pick(locale, L.note)}</p>
      <div className="notification-email-row">
        <span className={`notification-kind ${enabled ? "on" : "off"}`}>{enabled ? pick(locale, L.on) : pick(locale, L.off)}</span>
        <span className="notification-email-text">{enabled ? pick(locale, L.onBody) : pick(locale, L.offBody)}</span>
        <button className="text-button" type="button" disabled={pending} onClick={toggle}>
          {pending ? "…" : enabled ? pick(locale, L.disableButton) : pick(locale, L.enableButton)}
        </button>
      </div>
      {enabled ? <p className="overview-note">{pick(locale, L.warning)}</p> : null}
      {error ? <p className="description-dialog-error" role="alert">{error}</p> : null}
    </section>
  );
}
