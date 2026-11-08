"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SpecEntityType } from "@/lib/spec-verification";
import { verificationState, verificationLabels } from "@/lib/spec-editor-ui";
import { errorMessage } from "@/lib/error-message";
import { useDemoGuard } from "./demo-mode";

/** P1 核实动作入口：只读 demo 由 demo guard 拦截；非 editor 由服务端拒绝。 */
export function VerifySpecButton({ slug, entityType, entityId, item }: {
  slug: string;
  entityType: SpecEntityType;
  entityId: number;
  item: { verifiedAt?: Date | string | null; verifiedBy?: string | null; staleSince?: Date | string | null };
}) {
  const router = useRouter();
  const guard = useDemoGuard();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const state = verificationState(item);

  async function verify() {
    if (guard() || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch(`/api/products/${slug}/spec/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityType, entityId }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? "核实失败");
      }
      router.refresh();
    } catch (cause: unknown) {
      setError(errorMessage(cause, "核实失败"));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="verification-control">
      <span className={`verification-badge ${state}`} title={state === "verified" && item.verifiedBy ? `由 ${item.verifiedBy} 核实` : undefined}>
        {verificationLabels[state]}
      </span>
      <button className="text-button" type="button" disabled={pending} onClick={() => void verify()}>
        {pending ? "核实中…" : state === "verified" ? "重新核实" : "标记已核实"}
      </button>
      {error ? <span className="verification-error" role="alert">{error}</span> : null}
    </span>
  );
}
