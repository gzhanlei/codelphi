"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestAnalysis } from "@/lib/product-client";
import { errorMessage } from "@/lib/error-message";
import { useDemoGuard } from "./demo-mode";
import { InlineMessage, analysisButtonLabel } from "./form-feedback";

export function AnalyzeButton({ slug }: { slug: string }) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function analyze() {
    if (guard()) return;
    setPending(true);
    setMessage("");
    try {
      await requestAnalysis(slug);
      setMessage("分析已排队，稍后刷新查看");
      router.refresh();
    } catch (error) {
      setMessage(errorMessage(error, "分析请求失败"));
    } finally {
      setPending(false);
    }
  }

  const quotaBlocked = message.includes("额度不足");
  return (
    <div className="analyze-control">
      <button className="primary-button" type="button" onClick={analyze} disabled={pending}>
        {analysisButtonLabel(pending)}
      </button>
      <InlineMessage message={message} />
      {quotaBlocked ? (
        <p className="quota-blocked-hint">
          分析未执行、未计费。<Link href="/pricing">升级套餐或购买超额包 →</Link>
        </p>
      ) : null}
    </div>
  );
}
