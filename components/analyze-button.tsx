"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function AnalyzeButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function analyze() {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch(`/api/products/${slug}/analyze`, { method: "POST" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "分析请求失败");
      setMessage("分析已排队，稍后刷新查看");
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "分析请求失败");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="analyze-control">
      <button className="primary-button" type="button" onClick={analyze} disabled={pending}>
        {pending ? "正在提交…" : "立即分析"}
      </button>
      {message && <span className="inline-message">{message}</span>}
    </div>
  );
}
