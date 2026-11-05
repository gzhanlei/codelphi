"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

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
