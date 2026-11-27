"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { UiLocale } from "@/lib/ui-locale";
import { pick } from "@/lib/ui-locale";
import { PRODUCT_JOURNEYS, PRESENTATION_SETTINGS } from "@/lib/ui-strings/product";
import { errorMessage } from "@/lib/error-message";

/**
 * 手动重新生成理解层（设置页入口，编辑者及以上）。生成在后台执行，这里只提交并提示：
 * 接口立即返回调度结果（generating = 已开始；deferred = 已有一轮在跑），随后刷新页面取新状态。
 */
export function PresentationRegenerateButton({ slug, locale = "zh-CN" }: { slug: string; locale?: UiLocale }) {
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "pending" | "submitted" | "busy" | "error">("idle");
  const [detail, setDetail] = useState("");

  const regenerate = async () => {
    setStatus("pending");
    setDetail("");
    try {
      const response = await fetch(`/api/products/${slug}/presentation`, { method: "POST" });
      const body = await response.json().catch(() => ({})) as { outcome?: string; reason?: string; error?: string; message?: string };
      // 工作区没配模型时服务端回 409 并带着一句给人看的解释，优先显示它。
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
      if (body.outcome === "deferred") setStatus("busy");
      else if (body.outcome === "skipped") {
        setStatus("error");
        setDetail(pick(locale, PRODUCT_JOURNEYS.emptyNoSpec));
      } else setStatus("submitted");
      router.refresh();
    } catch (cause: unknown) {
      setStatus("error");
      setDetail(pick(locale, PRESENTATION_SETTINGS.error).replace("{reason}", errorMessage(cause, "")));
    }
  };

  return (
    <div className="presentation-regenerate">
      <button className="secondary-button" type="button" onClick={regenerate} disabled={status === "pending"} title={pick(locale, PRESENTATION_SETTINGS.regenerateTitle)}>
        {status === "pending" ? pick(locale, PRESENTATION_SETTINGS.regenerating) : pick(locale, PRESENTATION_SETTINGS.regenerate)}
      </button>
      {status === "submitted" ? <span role="status">{pick(locale, PRESENTATION_SETTINGS.submitted)}</span> : null}
      {status === "busy" ? <span role="status">{pick(locale, PRESENTATION_SETTINGS.submittedBusy)}</span> : null}
      {status === "error" ? <span className="presentation-error" role="alert">{detail}</span> : null}
    </div>
  );
}
