"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { errorMessage } from "@/lib/error-message";
import { connectionAction } from "@/lib/integration-client";
import { ConnectionActionButtons } from "./connection-action-buttons";
import { InlineMessage } from "./form-feedback";

export function ConnectionActions({ id, status }: { id: number; status: string }) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function run(action: "check" | "disconnect") {
    setPending(action);
    setError("");
    try {
      await connectionAction(id, action);
      router.refresh();
    } catch (cause) {
      setError(errorMessage(cause, "操作失败"));
    } finally {
      setPending("");
    }
  }

  return (
    <>
      <ConnectionActionButtons pending={pending} status={status} onRun={run} />
      <InlineMessage message={error} />
    </>
  );
}
