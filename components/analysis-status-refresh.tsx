"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function analysisRefreshDelay(status: string) {
  return status === "queued" || status === "running" ? 3_000 : null;
}

export function AnalysisStatusRefresh({ status }: { status: string }) {
  const router = useRouter();
  useEffect(() => {
    const delay = analysisRefreshDelay(status);
    if (delay === null) return;
    const timer = setInterval(() => router.refresh(), delay);
    return () => clearInterval(timer);
  }, [status, router]);
  return null;
}
