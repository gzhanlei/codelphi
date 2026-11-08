"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** 分析未结束（排队/运行中）时每 3 秒刷新一次服务端组件；结束后停止轮询（返回 null）。 */
export function analysisRefreshDelay(status: string) {
  return status === "queued" || status === "running" ? 3_000 : null;
}

function usePendingRefresh(pending: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => router.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [pending, router]);
}

export function AnalysisStatusRefresh({ status }: { status: string }) {
  usePendingRefresh(analysisRefreshDelay(status) !== null);
  return null;
}

export function ProductListRefresh({ pending }: { pending: boolean }) {
  usePendingRefresh(pending);
  return null;
}
