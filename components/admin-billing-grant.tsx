"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** 超管充值表单：按邮箱给任意用户发放 SAU（同 reason 幂等——重复提交不重复发放）。 */
export function AdminBillingGrant() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [units, setUnits] = useState("100");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState("");

  async function grant() {
    setPending(true);
    setResult("");
    try {
      const response = await fetch("/api/admin/billing/grant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, units: Number(units), reason }),
      });
      const data = await response.json();
      if (!response.ok) {
        setResult(`失败（${response.status}）：${data.message ?? data.error ?? "未知错误"}`);
        return;
      }
      setResult(data.granted
        ? `已发放 ${units} SAU 给 ${email}（钱包现余 ${data.newRemaining}）。`
        : `同 reason 已发放过（幂等跳过），钱包现余 ${data.newRemaining}。`);
      router.refresh();
    } catch (error) {
      setResult(error instanceof Error ? error.message : "充值请求失败");
    } finally {
      setPending(false);
    }
  }

  const valid = email.includes("@") && Number(units) > 0 && reason.trim().length >= 4;

  return (
    <div className="panel">
      <h2>手工充值</h2>
      <p>按邮箱给用户个人工作区的 Trial 钱包发放 SAU。同一 reason 只发放一次（重复提交幂等跳过）。</p>
      <div className="invite-form" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field" style={{ flex: "1 1 220px", minWidth: 220 }}>
          <span>用户邮箱</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" required />
        </label>
        <label className="field" style={{ flex: "0 0 120px", width: 120, maxWidth: 120 }}>
          <span>SAU 数量</span>
          <input type="number" min={1} value={units} onChange={(e) => setUnits(e.target.value)} required />
        </label>
        <label className="field" style={{ flex: "1 1 200px", minWidth: 200 }}>
          <span>原因（幂等标识，含日期）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`manual-topup-${new Date().toISOString().slice(0, 10)}`} required />
        </label>
        <button className="primary-button" type="button" disabled={pending || !valid} onClick={grant}>
          {pending ? "发放中…" : "发放"}
        </button>
      </div>
      {result ? <p className="success-text">{result}</p> : null}
    </div>
  );
}
