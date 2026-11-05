"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { requestAnalysis } from "@/lib/product-client";
import { errorMessage } from "@/lib/error-message";
import { useDemoMode } from "./demo-mode";
import { InlineMessage, analysisButtonLabel } from "./form-feedback";

export function AnalyzeButton({ slug }: { slug: string }) {
  const router = useRouter();
  const { demo, showNotice } = useDemoMode();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function analyze() {
    if (demo) {
      showNotice();
      return;
    }
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

  return (
    <div className="analyze-control">
      <button className="primary-button" type="button" onClick={analyze} disabled={pending}>
        {analysisButtonLabel(pending)}
      </button>
      <InlineMessage message={message} />
    </div>
  );
}
