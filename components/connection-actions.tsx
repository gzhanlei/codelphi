"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { errorMessage } from "../lib/error-message";
import { runConnectionAction } from "../lib/integration-client";
import { ConnectionActionButtons } from "./connection-action-buttons";
import { InlineMessage } from "./form-feedback";

type Action = "check" | "disconnect" | "delete";

interface ActionControls {
  isPending: () => boolean;
  setPending: (action: string) => void;
  setError: (message: string) => void;
  confirmDelete: () => boolean;
  refresh: () => void;
  runClient: typeof runConnectionAction;
}

export async function handleConnectionAction(id: number, action: Action, kind: "github" | "repository", controls: ActionControls) {
  if (controls.isPending()) return;
  if (action === "delete" && !controls.confirmDelete()) return;
  controls.setPending(action);
  controls.setError("");
  try {
    const result = await controls.runClient(id, action, kind);
    controls.setError(result.error ?? "");
    controls.refresh();
  } catch (cause) {
    controls.setError(errorMessage(cause, "操作失败"));
  } finally {
    controls.setPending("");
  }
}

export function ConnectionActions({ id, status, kind = "github" }: { id: number; status: string; kind?: "github" | "repository" }) {
  const router = useRouter();
  const [pending, setPending] = useState("");
  const pendingRef = useRef(false);
  const [error, setError] = useState("");

  function updatePending(action: string) {
    pendingRef.current = Boolean(action);
    setPending(action);
  }

  async function run(action: Action) {
    await handleConnectionAction(id, action, kind, {
      isPending: () => pendingRef.current,
      setPending: updatePending,
      setError,
      confirmDelete: () => window.confirm("删除后会清除 Radar 保存的访问令牌，且不能撤销。确定删除此连接吗？"),
      refresh: router.refresh,
      runClient: runConnectionAction,
    });
  }

  return (
    <>
      <ConnectionActionButtons pending={pending} status={status} kind={kind} onRun={run} />
      <InlineMessage message={error} />
    </>
  );
}
